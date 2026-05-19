import { expect, test } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import { validateClaudeDraftShortcutActions } from "./shortcut-verify";

const draftDir = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "claude-relay-drafts",
);

function actions(args: {
  relativeSubpath?: string;
  path?: string;
  showWhenRun?: boolean;
  directBodyAttachment?: boolean;
  fileLocationType?: string;
  fileProviderDomainID?: string;
}) {
  const bodyTokenAttachment = {
    Value: {
      Type: "ActionOutput",
      OutputName: "Dictionary Value",
      OutputUUID: "body",
      Aggrandizements: [
        {
          Type: "WFCoercionVariableAggrandizement",
          CoercionItemClass: "WFStringContentItem",
        },
      ],
    },
    WFSerializationType: "WFTextTokenAttachment",
  };

  return [
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.documentpicker.open",
      WFWorkflowActionParameters: {
        UUID: "get-file",
        WFShowFilePicker: false,
        WFFileErrorIfNotFound: true,
        WFGetFilePath: args.path ?? "latest.json",
        WFFile: {
          filename: "claude-relay-drafts",
          displayName: "claude-relay-drafts",
          fileLocation: {
            WFFileLocationType: args.fileLocationType ?? "iCloud",
            fileProviderDomainID: args.fileProviderDomainID ?? "com.apple.CloudDocs.iCloudDriveFileProvider/test",
            relativeSubpath:
              args.relativeSubpath ?? "com~apple~CloudDocs/claude-relay-drafts",
          },
        },
      },
    },
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.detect.dictionary",
      WFWorkflowActionParameters: {
        UUID: "dictionary",
        WFInput: {
          Value: {
            OutputName: "File",
            OutputUUID: "get-file",
            Type: "ActionOutput",
          },
          WFSerializationType: "WFTextTokenAttachment",
        },
      },
    },
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.getvalueforkey",
      WFWorkflowActionParameters: {
        UUID: "recipient",
        WFDictionaryKey: "recipient",
        WFInput: {
          Value: { OutputUUID: "dictionary", Type: "ActionOutput" },
          WFSerializationType: "WFTextTokenAttachment",
        },
      },
    },
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.getvalueforkey",
      WFWorkflowActionParameters: {
        UUID: "body",
        WFDictionaryKey: "body",
        WFInput: {
          Value: { OutputUUID: "dictionary", Type: "ActionOutput" },
          WFSerializationType: "WFTextTokenAttachment",
        },
      },
    },
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.sendmessage",
      WFWorkflowActionParameters: {
        UUID: "send",
        ShowWhenRun: args.showWhenRun ?? true,
        WFSendMessageActionRecipients: {
          Value: {
            Type: "ActionOutput",
            OutputName: "Dictionary Value",
            OutputUUID: "recipient",
          },
          WFSerializationType: "WFTextTokenAttachment",
        },
        WFSendMessageContent: args.directBodyAttachment
          ? bodyTokenAttachment
          : {
            Value: {
              string: "\uFFFC",
              attachmentsByRange: {
                "{0, 1}": bodyTokenAttachment.Value,
              },
            },
            WFSerializationType: "WFTextTokenString",
          },
      },
    },
  ];
}

test("accepts iCloud Drive folder bookmark with latest.json relative path", () => {
  const result = validateClaudeDraftShortcutActions(actions({}), { draftDir });

  expect(result).toEqual({ ok: true, errors: [], warnings: [] });
});

test("accepts iCloud Drive file bookmark when WFGetFilePath is empty", () => {
  const result = validateClaudeDraftShortcutActions(
    actions({
      relativeSubpath: "com~apple~CloudDocs/claude-relay-drafts/latest.json",
      path: "",
    }),
    { draftDir },
  );

  expect(result.ok).toBe(true);
});

test("rejects corrupted latest.jsoneon path", () => {
  const result = validateClaudeDraftShortcutActions(
    actions({ path: "latest.jsoneon" }),
    { draftDir },
  );

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("latest.jsoneon");
});

test("rejects Shortcuts provider path", () => {
  const result = validateClaudeDraftShortcutActions(
    actions({
      relativeSubpath: "iCloud~is~workflow~my~workflows/Documents/claude-relay-drafts",
    }),
    { draftDir },
  );

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("Shortcuts app iCloud container");
});

test("rejects non-iCloud file location", () => {
  const result = validateClaudeDraftShortcutActions(
    actions({ fileLocationType: "Local" }),
    { draftDir },
  );

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("must use iCloud file location");
});

test("rejects non-CloudDocs file provider", () => {
  const result = validateClaudeDraftShortcutActions(
    actions({ fileProviderDomainID: "com.example.LocalProvider/test" }),
    { draftDir },
  );

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("must use the CloudDocs iCloud Drive provider");
});

test("rejects missing Get File action", () => {
  const [, ...missingGetFile] = actions({});
  const result = validateClaudeDraftShortcutActions(missingGetFile, { draftDir });

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("missing the Get File action");
});

test("rejects Get File action after the dictionary parser", () => {
  const [getFile, ...rest] = actions({});
  const result = validateClaudeDraftShortcutActions([...rest, getFile], { draftDir });

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("Get File action must be first");
});

test("rejects dictionary parser not wired to Get File output", () => {
  const broken = actions({});
  broken[1].WFWorkflowActionParameters.WFInput.Value.OutputUUID = "wrong-output";
  const result = validateClaudeDraftShortcutActions(broken, { draftDir });

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("dictionary parser must read the Get File output");
});

test("rejects body lookup before recipient lookup", () => {
  const valid = actions({});
  const result = validateClaudeDraftShortcutActions(
    [valid[0], valid[1], valid[3], valid[2], valid[4]],
    { draftDir },
  );

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("recipient first, then body");
});

test("rejects CloudDocs folder bookmark with duplicated folder path", () => {
  const result = validateClaudeDraftShortcutActions(
    actions({ path: "claude-relay-drafts/latest.json" }),
    { draftDir },
  );

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("must use path latest.json");
});

test("rejects Send Message with Show When Run disabled", () => {
  const result = validateClaudeDraftShortcutActions(
    actions({ showWhenRun: false }),
    { draftDir },
  );

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("Show When Run enabled");
});

test("rejects extra actions after Send Message", () => {
  const broken = [
    ...actions({}),
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.comment",
      WFWorkflowActionParameters: {
        WFCommentActionText: "unexpected extra action",
      },
    },
  ];
  const result = validateClaudeDraftShortcutActions(broken, { draftDir });

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("exactly 5 actions");
});

test("rejects a second Send Message action even when the first is safe", () => {
  const valid = actions({});
  const secondSend = actions({ showWhenRun: false })[4];
  const result = validateClaudeDraftShortcutActions(
    [...valid, secondSend],
    { draftDir },
  );

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("exactly one Send Message action");
  expect(result.errors.join("\n")).toContain("exactly 5 actions");
});

test("rejects raw body attachment in Send Message content", () => {
  const result = validateClaudeDraftShortcutActions(
    actions({ directBodyAttachment: true }),
    { draftDir },
  );

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("raw WFTextTokenAttachment");
});

test("rejects Send Message content with multiple attachmentsByRange entries", () => {
  const base = actions({});
  const send = base[base.length - 1].WFWorkflowActionParameters as Record<string, unknown>;
  const content = send.WFSendMessageContent as Record<string, unknown>;
  const value = content.Value as Record<string, unknown>;
  value.attachmentsByRange = {
    "{0, 1}": { OutputUUID: "body", Type: "ActionOutput" },
    "{2, 1}": { OutputUUID: "other-action", Type: "ActionOutput" },
  };

  const result = validateClaudeDraftShortcutActions(base, { draftDir });

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("multiple attachmentsByRange entries");
});

test("rejects Send Message content with malformed attachmentsByRange key", () => {
  const base = actions({});
  const send = base[base.length - 1].WFWorkflowActionParameters as Record<string, unknown>;
  const content = send.WFSendMessageContent as Record<string, unknown>;
  const value = content.Value as Record<string, unknown>;
  value.attachmentsByRange = {
    "not a range": { OutputUUID: "body", Type: "ActionOutput" },
  };

  const result = validateClaudeDraftShortcutActions(base, { draftDir });

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("malformed attachmentsByRange key");
});

test("rejects Send Message content with no attachmentsByRange at all", () => {
  const base = actions({});
  const send = base[base.length - 1].WFWorkflowActionParameters as Record<string, unknown>;
  const content = send.WFSendMessageContent as Record<string, unknown>;
  content.Value = { string: "hello" };

  const result = validateClaudeDraftShortcutActions(base, { draftDir });

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("attachmentsByRange");
});

test("rejects recipient lookup that explicitly reads from a non-dictionary action", () => {
  const base = actions({});
  // Override WFInput to point at "get-file" instead of "dictionary"
  const recipientLookup = base[2].WFWorkflowActionParameters as Record<string, unknown>;
  recipientLookup.WFInput = {
    Value: { OutputUUID: "get-file", Type: "ActionOutput" },
    WFSerializationType: "WFTextTokenAttachment",
  };
  const result = validateClaudeDraftShortcutActions(base, { draftDir });
  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain(
    "recipient dictionary lookup WFInput points at get-file",
  );
});

test("accepts the canonical fixture with explicit WFInput on both lookups", () => {
  const result = validateClaudeDraftShortcutActions(actions({}), { draftDir });
  expect(result.ok).toBe(true);
});

test("rejects recipient lookup with missing WFInput (implicit chaining is no longer accepted)", () => {
  const base = actions({});
  const recipientLookup = base[2].WFWorkflowActionParameters as Record<string, unknown>;
  delete recipientLookup.WFInput;
  const result = validateClaudeDraftShortcutActions(base, { draftDir });
  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain(
    "recipient dictionary lookup is missing WFInput",
  );
});

test("rejects body lookup with missing WFInput", () => {
  const base = actions({});
  const bodyLookup = base[3].WFWorkflowActionParameters as Record<string, unknown>;
  delete bodyLookup.WFInput;
  const result = validateClaudeDraftShortcutActions(base, { draftDir });
  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain(
    "body dictionary lookup is missing WFInput",
  );
});

test("rejects body lookup that explicitly reads from a non-dictionary action", () => {
  const base = actions({});
  const bodyLookup = base[3].WFWorkflowActionParameters as Record<string, unknown>;
  bodyLookup.WFInput = {
    Value: { OutputUUID: "recipient", Type: "ActionOutput" },
    WFSerializationType: "WFTextTokenAttachment",
  };
  const result = validateClaudeDraftShortcutActions(base, { draftDir });
  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain(
    "body dictionary lookup WFInput points at recipient",
  );
});

test("rejects Send Message content whose attachmentsByRange points at a non-body action", () => {
  const base = actions({});
  const send = base[base.length - 1].WFWorkflowActionParameters as Record<string, unknown>;
  const content = send.WFSendMessageContent as Record<string, unknown>;
  const value = content.Value as Record<string, unknown>;
  value.attachmentsByRange = {
    "{0, 1}": { OutputUUID: "get-file", Type: "ActionOutput" },
  };

  const result = validateClaudeDraftShortcutActions(base, { draftDir });

  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("wrong action UUID");
});
