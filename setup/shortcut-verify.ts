import { existsSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, relative, sep } from "path";
import {
  defaultICloudDriveDraftDir,
  ICLOUD_DRIVE_DRAFT_FILE_NAME,
} from "../src/icloud-drive-draft.ts";
import { runCommandWithTimeout } from "./process-timeout.ts";

const DOCUMENT_PICKER_ACTION = "is.workflow.actions.documentpicker.open";
const DICTIONARY_ACTION = "is.workflow.actions.detect.dictionary";
const GET_VALUE_FOR_KEY_ACTION = "is.workflow.actions.getvalueforkey";
const SEND_MESSAGE_ACTION = "is.workflow.actions.sendmessage";
const SHORTCUTS_CONTAINER = "iCloud~is~workflow~my~workflows";
const BPLIST_MAGIC = Buffer.from("bplist00");

export interface ShortcutValidationOptions {
  draftDir?: string;
  fileName?: string;
}

export interface ShortcutValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ShortcutReadResult {
  ok: boolean;
  actions?: unknown[];
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  const record = asRecord(value);
  return record ? Object.values(record).flatMap(allStrings) : [];
}

function normalizeShortcutPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function actionIdentifier(action: unknown): string | undefined {
  return asString(asRecord(action)?.WFWorkflowActionIdentifier);
}

function outputUuidFromToken(token: unknown): string | undefined {
  const tokenRecord = asRecord(token);
  const value = asRecord(tokenRecord?.Value);
  if (!value) return undefined;

  if (tokenRecord?.WFSerializationType === "WFTextTokenAttachment") {
    return asString(value.OutputUUID);
  }

  if (tokenRecord?.WFSerializationType !== "WFTextTokenString") {
    return undefined;
  }

  const attachments = asRecord(value.attachmentsByRange);
  const uuids = attachments
    ? Object.values(attachments)
      .map((attachment) => asString(asRecord(attachment)?.OutputUUID))
      .filter((uuid): uuid is string => Boolean(uuid))
    : [];

  return uuids.length === 1 ? uuids[0] : undefined;
}

function expectedCloudRelativeDir(draftDir: string): string | undefined {
  const mobileDocuments = join(homedir(), "Library", "Mobile Documents");
  const rel = relative(mobileDocuments, draftDir);
  if (!rel || rel.startsWith("..") || rel === "..") return undefined;
  return rel.split(sep).join("/");
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runCommandWithTimeout(args, { timeoutMs: 10_000 });
  return {
    code: result.timedOut ? 124 : result.code,
    stdout: result.stdout,
    stderr: result.timedOut
      ? `Command timed out after 10000ms: ${args[0]}`
      : result.stderr,
  };
}

async function readWorkflowActionsPlist(plistPath: string): Promise<ShortcutReadResult> {
  const plutil = await run(["plutil", "-convert", "json", "-o", "-", plistPath]);
  if (plutil.code !== 0) {
    return {
      ok: false,
      error: plutil.stderr.trim() || `plutil exited ${plutil.code}`,
    };
  }

  const parsed = JSON.parse(plutil.stdout) as unknown;
  if (Array.isArray(parsed)) return { ok: true, actions: parsed };

  const record = asRecord(parsed);
  const workflowActions = record?.WFWorkflowActions;
  return Array.isArray(workflowActions)
    ? { ok: true, actions: workflowActions }
    : { ok: false, error: "Shortcut plist did not contain workflow actions" };
}

export function validateClaudeDraftShortcutActions(
  actions: unknown,
  options: ShortcutValidationOptions = {},
): ShortcutValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fileName = options.fileName ?? ICLOUD_DRIVE_DRAFT_FILE_NAME;
  const draftDir = options.draftDir ?? defaultICloudDriveDraftDir();
  const cloudRelativeDir = expectedCloudRelativeDir(draftDir);

  if (!Array.isArray(actions)) {
    return {
      ok: false,
      errors: ["ClaudeDraft actions are not an array"],
      warnings,
    };
  }

  const strings = allStrings(actions);
  const identifiers = actions.map(actionIdentifier);
  const expectedSequence = [
    DOCUMENT_PICKER_ACTION,
    DICTIONARY_ACTION,
    GET_VALUE_FOR_KEY_ACTION,
    GET_VALUE_FOR_KEY_ACTION,
    SEND_MESSAGE_ACTION,
  ];
  if (actions.length !== expectedSequence.length) {
    errors.push(`ClaudeDraft must contain exactly ${expectedSequence.length} actions`);
  }
  if (!expectedSequence.every((expected, index) => identifiers[index] === expected)) {
    errors.push(
      "ClaudeDraft action sequence must be Get File, Get Dictionary, recipient lookup, body lookup, Send Message",
    );
  }
  const recipientLookupKey = asString(
    asRecord(asRecord(actions[2])?.WFWorkflowActionParameters)?.WFDictionaryKey,
  );
  const bodyLookupKey = asString(
    asRecord(asRecord(actions[3])?.WFWorkflowActionParameters)?.WFDictionaryKey,
  );
  if (recipientLookupKey !== "recipient" || bodyLookupKey !== "body") {
    errors.push(
      "ClaudeDraft dictionary lookup order must be recipient first, then body",
    );
  }
  const sendMessageCount = identifiers.filter((id) => id === SEND_MESSAGE_ACTION).length;
  if (sendMessageCount !== 1) {
    errors.push("ClaudeDraft must contain exactly one Send Message action");
  }

  if (strings.some((s) => s.includes("latest.jsoneon"))) {
    errors.push("ClaudeDraft Get File path is corrupted to latest.jsoneon");
  }
  if (strings.some((s) => s.includes(SHORTCUTS_CONTAINER))) {
    errors.push("ClaudeDraft still references the Shortcuts app iCloud container");
  }

  const getFileIndex = actions.findIndex((action) => {
    return actionIdentifier(action) === DOCUMENT_PICKER_ACTION;
  });
  const getFileAction = getFileIndex === -1 ? undefined : actions[getFileIndex];
  const getFileParams = asRecord(asRecord(getFileAction)?.WFWorkflowActionParameters);
  if (!getFileParams) {
    errors.push("ClaudeDraft is missing the Get File action");
  } else {
    if (getFileIndex !== 0) {
      errors.push("ClaudeDraft Get File action must be first");
    }
    if (getFileParams.WFShowFilePicker !== false) {
      errors.push("ClaudeDraft Get File must have Show File Picker disabled");
    }
    if (getFileParams.WFFileErrorIfNotFound !== true) {
      errors.push("ClaudeDraft Get File must fail if latest.json is missing");
    }

    const getFilePath = normalizeShortcutPath(asString(getFileParams.WFGetFilePath) ?? "");
    const wfFile = asRecord(getFileParams.WFFile);
    const fileLocation = asRecord(wfFile?.fileLocation);
    const fileLocationType = asString(fileLocation?.WFFileLocationType);
    const fileProviderDomainID = asString(fileLocation?.fileProviderDomainID);
    const relativeSubpath = normalizeShortcutPath(
      asString(fileLocation?.relativeSubpath) ?? "",
    );

    if (fileLocationType !== "iCloud") {
      errors.push("ClaudeDraft Get File bookmark must use iCloud file location");
    }
    if (
      !fileProviderDomainID ||
      !fileProviderDomainID.startsWith("com.apple.CloudDocs.iCloudDriveFileProvider")
    ) {
      errors.push("ClaudeDraft Get File bookmark must use the CloudDocs iCloud Drive provider");
    }

    if (!cloudRelativeDir) {
      warnings.push(
        `Cannot validate iCloud Drive provider for custom draft dir: ${draftDir}`,
      );
    } else if (!relativeSubpath) {
      errors.push("ClaudeDraft Get File has no iCloud Drive bookmark");
    } else {
      const expectedFileSubpath = `${cloudRelativeDir}/${fileName}`;
      if (relativeSubpath === cloudRelativeDir) {
        if (getFilePath !== fileName) {
          errors.push(
            `ClaudeDraft folder bookmark must use path ${fileName}; got ${getFilePath || "(empty)"}`,
          );
        }
      } else if (relativeSubpath === expectedFileSubpath) {
        if (getFilePath) {
          errors.push(
            `ClaudeDraft file bookmark already points at ${fileName}; clear WFGetFilePath instead of ${getFilePath}`,
          );
        }
      } else {
        errors.push(
          `ClaudeDraft Get File bookmark points at ${relativeSubpath || "(empty)"}, expected ${cloudRelativeDir} or ${expectedFileSubpath}`,
        );
      }
    }
  }

  const dictionaryAction = actions.find((action) => {
    return actionIdentifier(action) === DICTIONARY_ACTION;
  });
  const dictionaryParams = asRecord(asRecord(dictionaryAction)?.WFWorkflowActionParameters);
  if (!dictionaryParams) {
    errors.push("ClaudeDraft is missing the Get Dictionary from Input action");
  } else if (getFileParams) {
    const dictionaryInput = asRecord(dictionaryParams.WFInput);
    const dictionaryValue = asRecord(dictionaryInput?.Value);
    const getFileUuid = asString(getFileParams.UUID);
    const dictionaryInputUuid = asString(dictionaryValue?.OutputUUID);
    if (!getFileUuid || dictionaryInputUuid !== getFileUuid) {
      errors.push("ClaudeDraft dictionary parser must read the Get File output");
    }
  }

  const dictionaryValueActions = actions
    .map((action) => asRecord(action))
    .filter((action) => actionIdentifier(action) === GET_VALUE_FOR_KEY_ACTION);
  const valueActionForKey = (key: string) => {
    return dictionaryValueActions.find((action) => {
      const params = asRecord(action?.WFWorkflowActionParameters);
      return asString(params?.WFDictionaryKey) === key;
    });
  };
  const recipientAction = valueActionForKey("recipient");
  const recipientParams = asRecord(recipientAction?.WFWorkflowActionParameters);
  if (!recipientParams) {
    errors.push("ClaudeDraft is missing the recipient dictionary lookup");
  }
  const bodyAction = valueActionForKey("body");
  const bodyParams = asRecord(bodyAction?.WFWorkflowActionParameters);
  if (!bodyParams) {
    errors.push("ClaudeDraft is missing the body dictionary lookup");
  }

  const sendMessageAction = actions.find((action) => {
    return actionIdentifier(action) === SEND_MESSAGE_ACTION;
  });
  const sendParams = asRecord(asRecord(sendMessageAction)?.WFWorkflowActionParameters);
  if (!sendParams) {
    errors.push("ClaudeDraft is missing the Send Message action");
  } else {
    if (sendParams.ShowWhenRun !== true) {
      errors.push("ClaudeDraft Send Message must have Show When Run enabled");
    }
    if (recipientParams) {
      const recipientUuid = asString(recipientParams.UUID);
      const sendRecipientUuid = outputUuidFromToken(sendParams.WFSendMessageActionRecipients);
      if (!recipientUuid || sendRecipientUuid !== recipientUuid) {
        errors.push("ClaudeDraft Send Message recipient must read the recipient dictionary value");
      }
    }
    if (bodyParams) {
      const bodyUuid = asString(bodyParams.UUID);
      const sendContent = asRecord(sendParams.WFSendMessageContent);
      const sendContentUuid = outputUuidFromToken(sendContent);
      if (
        !bodyUuid || sendContent?.WFSerializationType !== "WFTextTokenString" ||
        sendContentUuid !== bodyUuid
      ) {
        errors.push("ClaudeDraft Send Message content must wrap the body dictionary value as text");
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export async function readInstalledShortcutActions(
  shortcutName: string,
): Promise<ShortcutReadResult> {
  const dbPath = join(homedir(), "Library", "Shortcuts", "Shortcuts.sqlite");
  if (!existsSync(dbPath)) {
    return { ok: false, error: `Shortcuts database not found: ${dbPath}` };
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "relay-shortcut-verify-"));
  const plistPath = join(tmpRoot, "actions.plist");
  try {
    const sql = [
      "select writefile(",
      sqlQuote(plistPath),
      ", ZDATA) from ZSHORTCUTACTIONS where ZSHORTCUT = ",
      "(select Z_PK from ZSHORTCUT where ZNAME = ",
      sqlQuote(shortcutName),
      " and ZTOMBSTONED = 0 order by ZMODIFICATIONDATE desc limit 1) limit 1;",
    ].join("");

    const sqlite = await run(["sqlite3", dbPath, sql]);
    if (sqlite.code !== 0) {
      return {
        ok: false,
        error: sqlite.stderr.trim() || `sqlite3 exited ${sqlite.code}`,
      };
    }
    if (!existsSync(plistPath)) {
      return { ok: false, error: `Shortcut not found: ${shortcutName}` };
    }

    return await readWorkflowActionsPlist(plistPath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function readSignedShortcutFileActions(
  shortcutPath: string,
): Promise<ShortcutReadResult> {
  if (!existsSync(shortcutPath)) {
    return { ok: false, error: `Shortcut install file not found: ${shortcutPath}` };
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "relay-shortcut-file-verify-"));
  try {
    const shortcutBytes = await readFile(shortcutPath);
    let workflowBytes: Buffer;

    if (shortcutBytes.subarray(0, 4).toString("ascii") === "AEA1") {
      if (shortcutBytes.length < 12) {
        return { ok: false, error: "Signed Shortcut archive is truncated" };
      }

      const authLength = shortcutBytes.readUInt32LE(8);
      const authStart = 12;
      const authEnd = authStart + authLength;
      if (authLength <= 0 || authEnd > shortcutBytes.length) {
        return { ok: false, error: "Signed Shortcut archive has invalid auth data" };
      }

      const authPlist = join(tmpRoot, "auth.plist");
      await writeFile(authPlist, shortcutBytes.subarray(authStart, authEnd));

      const publicKey = await run([
        "plutil",
        "-extract",
        "SigningPublicKey",
        "raw",
        "-o",
        "-",
        authPlist,
      ]);
      if (publicKey.code !== 0) {
        return {
          ok: false,
          error: publicKey.stderr.trim() || `Could not read Shortcut signing key (${publicKey.code})`,
        };
      }

      const publicKeyBytes = Buffer.from(publicKey.stdout.trim(), "base64");
      if (publicKeyBytes.length === 0) {
        return { ok: false, error: "Signed Shortcut archive has an empty signing key" };
      }

      const decryptedPath = join(tmpRoot, "decrypted.shortcut");
      const decrypted = await run([
        "aea",
        "decrypt",
        "-i",
        shortcutPath,
        "-o",
        decryptedPath,
        "-sign-pub-value",
        `hex:${publicKeyBytes.toString("hex")}`,
      ]);
      if (decrypted.code !== 0) {
        return {
          ok: false,
          error: decrypted.stderr.trim() || `aea decrypt exited ${decrypted.code}`,
        };
      }

      const decryptedBytes = await readFile(decryptedPath);
      const workflowOffset = decryptedBytes.indexOf(BPLIST_MAGIC);
      if (workflowOffset === -1) {
        return { ok: false, error: "Decrypted Shortcut archive did not contain a workflow plist" };
      }
      workflowBytes = decryptedBytes.subarray(workflowOffset);
    } else {
      const workflowOffset = shortcutBytes.indexOf(BPLIST_MAGIC);
      if (workflowOffset === -1) {
        return { ok: false, error: "Shortcut file did not contain a workflow plist" };
      }
      workflowBytes = shortcutBytes.subarray(workflowOffset);
    }

    const workflowPlist = join(tmpRoot, "workflow.plist");
    await writeFile(workflowPlist, workflowBytes);
    return await readWorkflowActionsPlist(workflowPlist);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
