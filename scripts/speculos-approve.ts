/**
 * Auto-approves prompts on the Speculos emulator.
 *
 * Every EIP-712 signature Attenuate asks for is blind-signed, which on a Nano is a
 * warning screen, a walk through the typed data, and a confirmation. Driving that by
 * hand is fine once and unworkable in a test or a recorded demo, so this watches the
 * screen and answers only the screens that ask for an answer. Anything it does not
 * recognise it leaves alone, because pressing a button on an unknown screen is how
 * you end up in the settings menu with the next APDU failing 0x6980.
 *
 *   npx tsx scripts/speculos-approve.ts &
 */
const API = process.env.LEDGER_SPECULOS_URL ?? "http://localhost:5001";
const REJECT = process.env.SPECULOS_REJECT === "1";

const screen = async (base = API): Promise<string> => {
  try {
    const r = await fetch(`${base}/events?currentscreenonly=true`);
    const j = (await r.json()) as { events: { text: string }[] };
    return j.events.map((e) => e.text).join(" ");
  } catch {
    return "";
  }
};

const press = async (b: "left" | "right" | "both", base = API) => {
  await fetch(`${base}/button/${b}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "press-and-release" }),
  });
  await new Promise((r) => setTimeout(r, 250));
};

const IDLE = /app is ready/i;
const ENTER_FLOW = /Blind signing ahead|Review typed|Sign typed/i;
const CONFIRM = /^Sign message|^Approve|press\s+both\s+buttons/i;
const DECLINE = /^Reject/i;
const DONE = /Message signed|rejected/i;

/**
 * Drive the prompts until stopped. Exported so a deploy can answer its own emulator
 * in-process rather than spawning a second one it then has to hunt down and kill.
 */
export function driveApprovals(apiUrl = API): () => void {
  let stopped = false;
  void (async () => {
    let inFlow = false;
    for (;;) {
      if (stopped) return;
      const s = await screen(apiUrl);
      if (DONE.test(s)) {
        await press("both", apiUrl);
        inFlow = false;
      } else if (ENTER_FLOW.test(s)) {
        inFlow = true;
        await press(CONFIRM.test(s) ? "both" : "right", apiUrl);
      } else if (inFlow) {
        if (REJECT ? DECLINE.test(s) : CONFIRM.test(s)) await press("both", apiUrl);
        else await press("right", apiUrl);
      } else {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  })();
  return () => { stopped = true; };
}

async function main() {
  let inFlow = false;
  let last = "";
  for (;;) {
    const s = await screen();
    if (s && s !== last) {
      last = s;
      if (process.env.SPECULOS_VERBOSE === "1") console.error(`  [device] ${s}`);
    }

    if (DONE.test(s)) {
      await press("both");
      inFlow = false;
    } else if (ENTER_FLOW.test(s)) {
      inFlow = true;
      await press(CONFIRM.test(s) ? "both" : "right");
    } else if (inFlow) {
      if (REJECT ? DECLINE.test(s) : CONFIRM.test(s)) await press("both");
      else await press("right");
    } else if (!IDLE.test(s)) {
      // Not idle and not in a signing flow: sit still rather than wander the menus.
      await new Promise((r) => setTimeout(r, 250));
    } else {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

if (process.argv[1]?.endsWith("speculos-approve.ts")) main();
