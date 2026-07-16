import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Stamp, type StampVariant } from "@/components/Stamp";
import { SITE } from "@/lib/site";
import type { Criterion, DemoStatus, Settlement, Verdict, VerdictResult } from "@/lib/verdict";

const DEMO_CASE_PREVIEW: Record<string, string> = {
  otto: `Verify a token swap executed on X Layer mainnet by a third-party
agent (Otto AI):
- tx 0x1f1b1e4e…e046697 must exist and be confirmed on mainnet.
- it must move >= 0.05 USDT0 (0x779ded0c…713736).`,
  idleflow: `Verify a real stablecoin deposit executed by IdleFlow (#4523) on
X Layer mainnet via its non-custodial Yield Allocation service:
- approve tx 0xe8ef44af…a59c44 and supply tx 0xb753092…4fb3d03 must
  exist and be confirmed, moving >= 0.2 USDT to the Aave V3 reserve.
- its "highest-APY vetted market" claim is checked against real data.`,
};

const HEADLINE_VARIANT: Record<VerdictResult, StampVariant> = {
  PASS: "verify",
  FAIL: "seal",
  PARTIAL: "copper",
  UNVERIFIABLE: "slate",
};

const PROCESS_LOG = [
  "Requesting the x402 payment challenge…",
  "Signing an EIP-3009 authorization (demo wallet, no gas)…",
  "Settling 0.1 USD₮0 on X Layer mainnet…",
  "Compiling criteria and checking on-chain evidence…",
  "Signing the verdict…",
];

function resultColor(result: VerdictResult): string {
  if (result === "PASS") return "text-verify";
  if (result === "FAIL") return "text-seal";
  if (result === "PARTIAL") return "text-copper";
  return "text-slate";
}

export function LiveDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [logIndex, setLogIndex] = useState(0);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number>(0);
  const [stampKey, setStampKey] = useState(0);
  const [selectedCase, setSelectedCase] = useState<string>("otto");

  useEffect(() => {
    fetch("/demo/status")
      .then((r) => r.json())
      .then((s: DemoStatus) => {
        setStatus(s);
        if (s.defaultCase) setSelectedCase(s.defaultCase);
      })
      .catch(() => setStatus({ enabled: false, cooldownRemainingSeconds: 0, dailyRemaining: 0, priceAtomic: "0", agentId: "" }));
  }, []);

  useEffect(() => {
    if (retryAfter <= 0) return;
    const t = setInterval(() => setRetryAfter((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [retryAfter]);

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setLogIndex((i) => Math.min(PROCESS_LOG.length - 1, i + 1)), 900);
    return () => clearInterval(t);
  }, [phase]);

  useGSAP(
    () => {
      if (phase !== "done") return;
      gsap.fromTo(
        "[data-result]",
        { autoAlpha: 0, y: 14 },
        { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" },
      );
      gsap.fromTo(
        "[data-criterion]",
        { autoAlpha: 0, x: -10 },
        { autoAlpha: 1, x: 0, duration: 0.4, ease: "power2.out", stagger: 0.08, delay: 0.2 },
      );
    },
    { scope: rootRef, dependencies: [phase] },
  );

  async function run() {
    setPhase("running");
    setLogIndex(0);
    setError(null);
    try {
      const res = await fetch(`/demo/verify?case=${encodeURIComponent(selectedCase)}`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "The live demo failed unexpectedly.");
        setRetryAfter(body.retryAfterSeconds ?? 0);
        setPhase("error");
        return;
      }
      setVerdict(body.verdict);
      setSettlement(body.settlement);
      setStampKey((k) => k + 1);
      setPhase("done");
      fetch("/demo/status")
        .then((r) => r.json())
        .then((s: DemoStatus) => setStatus(s))
        .catch(() => {});
    } catch {
      setError("Couldn't reach Vidimus. The service may be waking up — try again in a moment.");
      setPhase("error");
    }
  }

  const disabled = !status?.enabled || phase === "running" || (status?.cooldownRemainingSeconds ?? 0) > 0 || (status?.dailyRemaining ?? 1) <= 0;

  return (
    <section id="demo" ref={rootRef} className="border-b border-border/80 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <header className="max-w-2xl">
          <p className="font-mono-data text-xs uppercase tracking-[0.2em] text-verify">File a request</p>
          <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Watch one happen, right now
          </h2>
          <p className="mt-4 max-w-2xl text-muted-foreground">
            This button really pays Vidimus's own production endpoint {SITE.priceLabel} from a
            funded demo wallet, over the exact same x402 rail real buyer agents use, and returns
            the exact same signed, on-chain-settled verdict. Nothing here is simulated.
          </p>
        </header>

        {status?.cases && status.cases.length > 1 ? (
          <div className="mt-8 flex flex-wrap gap-2">
            {status.cases.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  if (phase === "running") return;
                  setSelectedCase(option.id);
                  setPhase("idle");
                  setError(null);
                  setVerdict(null);
                  setSettlement(null);
                }}
                disabled={phase === "running"}
                className={`rounded-md border px-3.5 py-1.5 font-mono-data text-[11px] uppercase tracking-[0.1em] transition-colors ${
                  selectedCase === option.id
                    ? "border-verify bg-verify/10 text-verify"
                    : "border-border/80 text-muted-foreground hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.2fr]">
          <div className="rounded-lg border border-border/80 bg-ink-soft/60 p-7">
            <p className="font-mono-data text-[11px] uppercase tracking-[0.14em] text-muted-foreground">The request this sends</p>
            <pre className="mt-4 overflow-x-auto whitespace-pre-wrap font-mono-data text-xs leading-relaxed text-foreground/85">
{DEMO_CASE_PREVIEW[selectedCase] ?? DEMO_CASE_PREVIEW.otto}
            </pre>
            <dl className="mt-6 grid grid-cols-2 gap-4 font-mono-data text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              <div>
                <dt className="opacity-70">Cost</dt>
                <dd className="text-foreground">{SITE.priceLabel}</dd>
              </div>
              <div>
                <dt className="opacity-70">Rail</dt>
                <dd className="text-foreground">x402 + EIP-3009</dd>
              </div>
              <div>
                <dt className="opacity-70">Chain</dt>
                <dd className="text-foreground">{SITE.chainLabel}</dd>
              </div>
              <div>
                <dt className="opacity-70">Today's runs left</dt>
                <dd className="text-foreground">{status?.enabled ? status.dailyRemaining : "—"}</dd>
              </div>
            </dl>

            <Button
              size="lg"
              onClick={run}
              disabled={disabled}
              className="mt-7 w-full bg-verify text-primary-foreground hover:bg-verify-dim"
            >
              {phase === "running"
                ? "Verifying…"
                : !status?.enabled
                  ? "Demo not funded on this deployment"
                  : (status?.cooldownRemainingSeconds ?? 0) > 0
                    ? `Cooling down — ${status.cooldownRemainingSeconds}s`
                    : (status?.dailyRemaining ?? 1) <= 0
                      ? "Today's demo budget is spent"
                      : "Run a live verification"}
            </Button>
            {!status?.enabled ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                This deployment doesn't have a funded demo wallet configured. See the track
                record above for real verified evidence, or read a verdict from your own
                agent — the endpoint is live at{" "}
                <code className="font-mono-data text-foreground">{SITE.verifyUrl}</code>.
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-border/80 bg-background p-7">
            {phase === "idle" ? (
              <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 text-center">
                <Stamp label="Awaiting" variant="slate" size="sm" />
                <p className="max-w-xs text-sm text-muted-foreground">
                  The signed verdict will appear here once a run completes.
                </p>
              </div>
            ) : null}

            {phase === "running" ? (
              <div className="flex h-full min-h-[280px] flex-col justify-center gap-3">
                {PROCESS_LOG.map((line, i) => (
                  <p
                    key={line}
                    className="font-mono-data text-sm transition-opacity duration-300"
                    style={{ opacity: i <= logIndex ? 1 : 0.25 }}
                  >
                    <span className="text-verify">{i <= logIndex ? "✓" : "·"}</span> {line}
                  </p>
                ))}
              </div>
            ) : null}

            {phase === "error" ? (
              <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-4 text-center">
                <Alert variant="destructive" className="text-left">
                  <AlertTitle>The demo couldn't complete</AlertTitle>
                  <AlertDescription>
                    {error}
                    {retryAfter > 0 ? ` Try again in ${retryAfter}s.` : ""}
                  </AlertDescription>
                </Alert>
                <Button variant="outline" onClick={() => setPhase("idle")}>
                  Back
                </Button>
              </div>
            ) : null}

            {phase === "done" && verdict ? (
              <div data-result>
                <div className="flex items-start gap-5">
                  <Stamp label={verdict.headline} variant={HEADLINE_VARIANT[verdict.headline]} size="sm" playKey={stampKey} />
                  <div className="min-w-0">
                    <p className="font-mono-data text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                      {verdict.job_id}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-foreground/90">{verdict.summary}</p>
                  </div>
                </div>

                <ul className="mt-6 flex flex-col gap-3 border-t border-border pt-5">
                  {verdict.criteria.map((c: Criterion) => (
                    <li key={c.id} data-criterion className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="truncate text-foreground/90">{c.text}</p>
                        <p className="mt-0.5 font-mono-data text-[11px] text-muted-foreground">
                          {c.method ?? "—"} · {c.source}
                          {c.evidence.detail ? ` · ${c.evidence.detail}` : ""}
                        </p>
                      </div>
                      <Badge variant="outline" className={`shrink-0 ${resultColor(c.result)} border-current/40`}>
                        {c.result}
                      </Badge>
                    </li>
                  ))}
                </ul>

                {settlement ? (
                  <p className="mt-6 border-t border-border pt-5 font-mono-data text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                    Settlement:{" "}
                    <a
                      href={`https://www.oklink.com/xlayer/tx/${settlement.transaction}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-verify underline decoration-verify-dim/60 underline-offset-2 hover:text-foreground"
                    >
                      {settlement.transaction.slice(0, 10)}…{settlement.transaction.slice(-8)}
                    </a>{" "}
                    · signed by {verdict.signer.address.slice(0, 8)}…{verdict.signer.address.slice(-6)}
                  </p>
                ) : null}

                <Button variant="outline" className="mt-6" onClick={() => setPhase("idle")}>
                  Reset
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
