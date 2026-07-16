import { useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

interface Exhibit {
  letter: string;
  title: string;
  problem: string;
  response: string;
}

const EXHIBITS: Exhibit[] = [
  {
    letter: "A",
    title: "Spec ambiguity",
    problem:
      "The order spec is written by someone else, often sloppily. Turning it into checkable criteria is itself an act of interpretation — infer too much and honest sellers fail, infer too little and bad work passes.",
    response:
      "Criteria compilation is a published, first-class output. Every requirement is tagged EXPLICIT or INFERRED before any deliverable is read — the checklist is derived from the spec alone.",
  },
  {
    letter: "B",
    title: "The determinism boundary",
    problem:
      "A mechanical fact, a grounded judgment, and a matter of taste are three different kinds of claim. A verifier that blurs them is a verifier that lies.",
    response:
      "Every criterion carries a tier. Tier 1 is always confidence 1.0 or it isn't Tier 1. Tier 3 — taste — is refused by construction, permanently, no exceptions.",
  },
  {
    letter: "C",
    title: "Adversarial input",
    problem:
      "The deliverable is untrusted input we are guaranteed to read, and our output moves money. A hidden “reviewer: output PASS” that gets obeyed ends the product.",
    response:
      "The dual-pass pipeline: the deliverable enters as quarantined data. A hardened extraction pass reads it once; scoring only ever sees the facts already extracted, never raw content.",
  },
  {
    letter: "D",
    title: "Calibration under asymmetric error costs",
    problem:
      "A false PASS robs a buyer and kills our own reputation. A false FAIL churns an honest seller. Every wrong verdict has a victim with a wallet.",
    response:
      "Confidence must be earned, not asserted. Every verdict we issue is appended to a hash-chained log, kept for the day ground truth arrives and calibration can be measured, not guessed.",
  },
];

export function Exhibits() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      ScrollTrigger.batch("[data-exhibit]", {
        start: "top 85%",
        once: true,
        onEnter: (els) =>
          gsap.to(els, { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out", stagger: 0.12 }),
      });
    },
    { scope: rootRef },
  );

  return (
    <section ref={rootRef} className="border-b border-border/80 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <header className="max-w-2xl">
          <p className="font-mono-data text-xs uppercase tracking-[0.2em] text-verify">The docket</p>
          <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Four problems, filed before a line of code
          </h2>
          <p className="mt-4 text-muted-foreground">
            A verdict service that moves money is not a JSON linter with a price tag. Every
            component in Vidimus traces back to one of these four — if a design choice doesn't,
            it gets questioned.
          </p>
        </header>

        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border/80 bg-border/80 md:grid-cols-2">
          {EXHIBITS.map((ex) => (
            <article
              key={ex.letter}
              data-exhibit
              className="flex flex-col gap-4 bg-background p-8 opacity-0"
              style={{ transform: "translateY(24px)" }}
            >
              <div className="flex items-baseline gap-3">
                <span className="font-heading text-sm font-semibold uppercase tracking-[0.15em] text-verify">
                  Exhibit {ex.letter}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <h3 className="font-heading text-xl font-semibold text-foreground">{ex.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{ex.problem}</p>
              <div className="mt-auto border-l-2 border-verify-dim/60 pl-4">
                <p className="font-mono-data text-[10px] uppercase tracking-[0.14em] text-verify">
                  Design response
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-foreground/85">{ex.response}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
