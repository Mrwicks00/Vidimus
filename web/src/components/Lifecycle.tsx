import { useRef, useState } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

interface Stage {
  n: string;
  title: string;
  detail: string;
}

const STAGES: Stage[] = [
  { n: "01", title: "Caller hits /verify, unpaid", detail: "No PAYMENT-SIGNATURE header → HTTP 402 challenge returned, a paymentId minted for this attempt." },
  { n: "02", title: "Buyer signs, facilitator settles", detail: "Buyer signs an EIP-3009 transferWithAuthorization offline — no gas, no pre-approval. Vidimus's facilitator wallet submits it on-chain and pays the gas." },
  { n: "03", title: "Ingest — quarantine", detail: "Spec and every deliverable bucket are sealed as data before anything downstream reads them. Never executed, never treated as instruction." },
  { n: "04", title: "Criteria compilation", detail: "Spec → checklist[]. Each item tagged EXPLICIT or INFERRED, tiered 1–3. The deliverable has not been opened yet." },
  { n: "05", title: "Module dispatch", detail: "Each criterion is routed to its checker: onchain, data, code, or content — mechanical, Tier 1. Taste is routed nowhere; it's refused." },
  { n: "06", title: "Evidence assembly", detail: "Per-criterion results collected with evidence pointers. Dual-pass boundary: scoring reads only facts already extracted, never raw content." },
  { n: "07", title: "Verdict computation", detail: "Headline is a pure function of Tier 1–2 results only. An EXPLICIT failure sinks it to FAIL; nothing scoreable is UNVERIFIABLE." },
  { n: "08", title: "Sign & anchor", detail: "ECDSA over the canonical verdict bytes. The recovered signer matches the live on-chain ERC-8004 owner of agent 4933 — checkable by anyone." },
  { n: "09", title: "Response", detail: "Signed verdict JSON returned, permanently welded to the settlement transaction that paid for it via payment_id." },
  { n: "10", title: "Calibration log", detail: "The verdict is appended to a hash-chained, append-only log — free ground truth for the day arbitration outcomes start arriving." },
];

export function Lifecycle() {
  const rootRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);

  useGSAP(
    () => {
      ScrollTrigger.create({
        trigger: rootRef.current,
        start: "top top",
        end: `+=${STAGES.length * 340}`,
        pin: true,
        scrub: 0.4,
        onUpdate: (self) => {
          const idx = Math.min(STAGES.length - 1, Math.floor(self.progress * STAGES.length));
          if (idx !== activeRef.current) {
            activeRef.current = idx;
            setActive(idx);
          }
          if (fillRef.current) {
            gsap.set(fillRef.current, { height: `${self.progress * 100}%` });
          }
        },
      });
    },
    { scope: rootRef },
  );

  const stage = STAGES[active];

  return (
    <section id="lifecycle" ref={rootRef} className="relative border-b border-border/80 bg-ink-soft/40 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <header className="max-w-2xl">
          <p className="font-mono-data text-xs uppercase tracking-[0.2em] text-verify">Chain of custody</p>
          <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            One job, ten steps, no shortcuts
          </h2>
          <p className="mt-4 text-muted-foreground">
            Scroll to walk the exact path a paid request takes through the pipeline, in order.
          </p>
        </header>

        <div className="mt-16 grid grid-cols-1 gap-10 md:grid-cols-[auto_1fr]">
          <div className="hidden md:flex md:flex-col md:items-center md:gap-0">
            <div className="relative h-[420px] w-px bg-border">
              <div ref={fillRef} className="absolute left-0 top-0 w-px bg-verify" style={{ height: "0%" }} />
              {STAGES.map((s, i) => (
                <div
                  key={s.n}
                  className="absolute left-1/2 -translate-x-1/2 rounded-full transition-colors duration-300"
                  style={{
                    top: `${(i / (STAGES.length - 1)) * 100}%`,
                    width: i === active ? 9 : 6,
                    height: i === active ? 9 : 6,
                    marginTop: i === active ? -4.5 : -3,
                    backgroundColor: i <= active ? "var(--verify)" : "var(--border)",
                  }}
                />
              ))}
            </div>
          </div>

          <div className="min-h-[220px]">
            <div className="font-mono-data text-6xl font-semibold text-verify/25 sm:text-7xl">{stage.n}</div>
            <h3 className="mt-2 font-heading text-2xl font-semibold text-foreground sm:text-3xl">{stage.title}</h3>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">{stage.detail}</p>

            <div className="mt-8 flex flex-wrap gap-2 md:hidden">
              {STAGES.map((s, i) => (
                <span
                  key={s.n}
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: i <= active ? "var(--verify)" : "var(--border)" }}
                />
              ))}
            </div>

            <p className="mt-10 font-mono-data text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Step {String(active + 1).padStart(2, "0")} / {String(STAGES.length).padStart(2, "0")} — keep
              scrolling
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
