// magpie's plugin entry.
//
// The plugin gives two tools — one starts a scan in the background, one
// reports what the monitor knows — and starts the schedule that runs at
// midnight and every three hours. magpie calls this once per plugin host, at
// its start and after every plugin change; a plugin host that restarts starts
// the schedule again, and the scan lock keeps two runs from overlapping.

import { logLine, loadConfig } from "./lib/config.mjs";
import { statusReport } from "./lib/core.mjs";
import { createManualController } from "./lib/manual.mjs";
import { ensureRunner, schedulePlan, startScheduler } from "./lib/schedule.mjs";

const manual = createManualController();

export default async function codexRouteMonitor(input, options) {
  const config = loadConfig();
  // a plugin update replaces this folder: put the Windows launcher back where
  // the scheduled tasks expect it, before a slot can come round
  try {
    ensureRunner();
  } catch (error) {
    logLine(`the Windows launcher could not be written: ${String(error?.message ?? error)}`);
  }
  const started = startScheduler({ config });
  logLine(
    `codex-route-monitor loaded (${started.started ? "schedule on" : `schedule not started: ${started.reason}`})`,
    { echo: false },
  );
  return {
    tool: {
      codex_route_scan: {
        description:
          "Start a Codex account routing scan in the background: probe each account with ModelTrace's random-number challenge through codex, attribute the model that answered, and put accounts held back (Luna) out of use. Returns started or busy at once; read progress and results with codex_route_status.",
        args: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              enum: ["enabled", "all"],
              description:
                "enabled (default): the accounts magpie has in use. all: every Codex account, including ones out of use.",
            },
            dry_run: {
              type: "boolean",
              description: "Report alone: leave magpie's account switches as they are.",
            },
          },
          required: [],
        },
        execute: manual.start,
      },
      codex_route_status: {
        description:
          "Report the Codex route monitor: every account's last diagnosis (the model that answered, whether it was Luna), whether it is in use, and the schedule's slots.",
        args: { type: "object", properties: {}, required: [] },
        execute: async () => {
          const report = statusReport();
          const config = loadConfig();
          return {
            ...report,
            schedule: schedulePlan(config),
            bank: "data/unified_bank.json (ModelTrace)",
          };
        },
      },
    },
  };
}
