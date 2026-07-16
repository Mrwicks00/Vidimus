import { useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { Badge } from "@/components/ui/badge";

interface Row {
  family: string;
  tier: 1 | 3;
  methods: string;
  proves: string;
}

const ROWS: Row[] = [
  {
    family: "Onchain",
    tier: 1,
    methods: "tx_exists · transfer_check · destination_check · owner_check · safety",
    proves: "The claimed transaction is real and confirmed, moved what was promised to where it was promised, and the assets involved pass token-safety screening — read directly from mainnet.",
  },
  {
    family: "Data",
    tier: 1,
    methods: "schema · rowcount · sample_verify",
    proves: "The dataset parses against its declared schema, meets stated row-count thresholds, and a commit-after-delivery random sample of rows survives inspection.",
  },
  {
    family: "Code",
    tier: 1,
    methods: "compiles · tests_pass",
    proves: "The delivered code actually builds and its test suite actually passes — executed inside an isolated sandbox, never on the host.",
  },
  {
    family: "Content",
    tier: 1,
    methods: "presence · format · bounds · pattern",
    proves: "Required headings/keys/columns are present, the document validates in its own declared format, counts are in bounds, values match a vetted pattern registry.",
  },
  {
    family: "Taste",
    tier: 3,
    methods: "refused",
    proves: "Nothing. Subjective quality is refused by construction — the honest answer, encoded as an invariant instead of a promise.",
  },
];

export function EvidenceRegistry() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      ScrollTrigger.batch("[data-row]", {
        start: "top 88%",
        once: true,
        onEnter: (els) => gsap.to(els, { autoAlpha: 1, x: 0, duration: 0.5, ease: "power2.out", stagger: 0.08 }),
      });
    },
    { scope: rootRef },
  );

  return (
    <section id="registry" ref={rootRef} className="border-b border-border/80 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <header className="max-w-2xl">
          <p className="font-mono-data text-xs uppercase tracking-[0.2em] text-verify">Registry</p>
          <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Fifteen methods, one mechanical fact each
          </h2>
          <p className="mt-4 max-w-2xl text-muted-foreground">
            No Tier-1 checker ever reads a deliverable and reasons about what it "seems" to
            satisfy. Each one resolves a declared, quarantined claim mechanically — or returns{" "}
            <span className="text-slate">UNVERIFIABLE</span> if it can't.
          </p>
        </header>

        <div className="mt-12 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border font-mono-data text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                <th className="w-40 py-3 pr-4 font-medium">Family</th>
                <th className="w-16 py-3 pr-4 font-medium">Tier</th>
                <th className="w-72 py-3 pr-4 font-medium">Methods</th>
                <th className="py-3 font-medium">What it proves</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr
                  key={row.family}
                  data-row
                  className="border-b border-border/70 opacity-0 last:border-0"
                  style={{ transform: "translateX(-16px)" }}
                >
                  <td className="py-5 pr-4 align-top font-heading text-base font-semibold text-foreground">
                    {row.family}
                  </td>
                  <td className="py-5 pr-4 align-top">
                    <Badge
                      variant="outline"
                      className={
                        row.tier === 1
                          ? "border-verify-dim/60 text-verify"
                          : "border-slate/50 text-slate"
                      }
                    >
                      Tier {row.tier}
                    </Badge>
                  </td>
                  <td className="py-5 pr-4 align-top font-mono-data text-xs leading-relaxed text-foreground/80">
                    {row.methods}
                  </td>
                  <td className="py-5 align-top text-sm leading-relaxed text-muted-foreground">{row.proves}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
