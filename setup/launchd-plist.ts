// Pure plist renderer for the launchd job. All inputs are explicit so the
// generator is unit-testable without depending on the host's filesystem,
// $HOME, or which Bun the resolver picked up. configure-launchd.ts feeds the
// resolved realpath and env in.

export interface KeepAliveDict {
  successfulExit: boolean;
  crashed: boolean;
}

export interface RelayPlistOptions {
  label: string;
  script: string;
  bunRealpath: string;
  projectRoot: string;
  home: string;
  logsDir: string;
  env: Record<string, string>;
  keepAlive: KeepAliveDict | false;
  throttleInterval?: number;
  exitTimeOut?: number;
  calendarIntervals?: { Hour: number; Minute: number }[];
  // Optional wrapper: when both are provided, the launchd job execs the
  // wrapper executable directly and tags the AssociatedBundleIdentifiers so
  // TCC/FDA attaches to the wrapper bundle rather than the versioned Bun
  // realpath in ProgramArguments[0].
  wrapperExecutablePath?: string;
  wrapperBundleId?: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stringTag(value: string): string {
  return `<string>${xmlEscape(value)}</string>`;
}

function renderEnv(env: Record<string, string>): string {
  const entries = Object.entries(env);
  if (entries.length === 0) return "";
  const inner = entries
    .map(([k, v]) => `        <key>${xmlEscape(k)}</key>\n        ${stringTag(v)}`)
    .join("\n");
  return `    <key>EnvironmentVariables</key>\n    <dict>\n${inner}\n    </dict>\n`;
}

function renderCalendarIntervals(intervals: { Hour: number; Minute: number }[]): string {
  return `    <key>StartCalendarInterval</key>\n    <array>${intervals
    .map(
      (ci) =>
        `\n        <dict>\n            <key>Hour</key>\n            <integer>${ci.Hour}</integer>\n            <key>Minute</key>\n            <integer>${ci.Minute}</integer>\n        </dict>`,
    )
    .join("")}\n    </array>\n`;
}

export function generateRelayPlist(opts: RelayPlistOptions): string {
  const useWrapper = Boolean(opts.wrapperExecutablePath && opts.wrapperBundleId);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  );
  lines.push('<plist version="1.0">');
  lines.push("<dict>");
  lines.push(`    <key>Label</key>\n    ${stringTag(opts.label)}`);
  lines.push("");
  if (useWrapper) {
    lines.push(
      `    <key>ProgramArguments</key>\n    <array>\n        ${stringTag(opts.wrapperExecutablePath as string)}\n    </array>`,
    );
    lines.push("");
    lines.push(
      `    <key>AssociatedBundleIdentifiers</key>\n    ${stringTag(opts.wrapperBundleId as string)}`,
    );
  } else {
    lines.push(
      `    <key>ProgramArguments</key>\n    <array>\n        ${stringTag(opts.bunRealpath)}\n        ${stringTag("run")}\n        ${stringTag(opts.script)}\n    </array>`,
    );
  }
  lines.push("");
  lines.push(`    <key>WorkingDirectory</key>\n    ${stringTag(opts.projectRoot)}`);
  lines.push("");
  lines.push(renderEnv(opts.env).trimEnd());

  if (opts.keepAlive !== false) {
    lines.push("");
    lines.push("    <key>RunAtLoad</key>\n    <true/>");
    lines.push("");
    lines.push(
      `    <key>KeepAlive</key>\n    <dict>\n        <key>SuccessfulExit</key>\n        ${opts.keepAlive.successfulExit ? "<true/>" : "<false/>"}\n        <key>Crashed</key>\n        ${opts.keepAlive.crashed ? "<true/>" : "<false/>"}\n    </dict>`,
    );
    lines.push("");
    lines.push(
      `    <key>ThrottleInterval</key>\n    <integer>${opts.throttleInterval ?? 30}</integer>`,
    );
    lines.push("");
    lines.push(
      `    <key>ExitTimeOut</key>\n    <integer>${opts.exitTimeOut ?? 20}</integer>`,
    );
  }

  if (opts.calendarIntervals && opts.calendarIntervals.length > 0) {
    lines.push("");
    lines.push(renderCalendarIntervals(opts.calendarIntervals).trimEnd());
  }

  lines.push("");
  lines.push(
    `    <key>StandardOutPath</key>\n    ${stringTag(`${opts.logsDir}/${opts.label}.log`)}`,
  );
  lines.push("");
  lines.push(
    `    <key>StandardErrorPath</key>\n    ${stringTag(`${opts.logsDir}/${opts.label}.error.log`)}`,
  );
  lines.push("</dict>");
  lines.push("</plist>");
  return lines.join("\n");
}
