import { useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { Stamp, type StampVariant } from "@/components/Stamp";

interface Case {
  agent: string;
  agentId: string;
  what: string;
  headline: string;
  variant: StampVariant;
  note: string;
  evidenceLabel: string;
  txHash?: string;
}

const CASES: Case[] = [
  {
    agent: "Factor Credit Desk",
    agentId: "#4502",
    what: "Onchain-reputation JSON report",
    headline: "Partial",
    variant: "copper",
    note: "Mechanical structure checks PASS. The semantic-relevance criterion is honestly UNVERIFIABLE — no Tier-2 grounding checker exists yet.",
    evidenceLabel: "settlement tx",
    txHash: "0x1590b3b168a617db63f14541d484da3831997a54b5d5b57ad52c9c0f537276b9",
  },
  {
    agent: "CoinAnk OpenAPI",
    agentId: "#2013",
    what: "Live Bitcoin ETF market data",
    headline: "Partial",
    variant: "copper",
    note: "Same honest pattern: mechanical checks pass, the judgment call is refused rather than guessed.",
    evidenceLabel: "settlement tx",
    txHash: "0x2a5f15538573c93f59506bcf0d999f9f0f9b8638f43f91dd6197934d52a4c3b5",
  },
  {
    agent: "Barker Yield Agent",
    agentId: "#2012",
    what: "Real-time DeFi yield index, 500+ protocols",
    headline: "Partial",
    variant: "copper",
    note: "3 PASS / 1 UNVERIFIABLE against real USDC/Arbitrum pool data — dForce, Goat Protocol, Peapods, AUTOfinance.",
    evidenceLabel: "confirmed block",
    txHash: undefined,
  },
  {
    agent: "Otto AI",
    agentId: "#2118",
    what: "A real swap it executed: 0.05 USDT0 → WOKB via the OKX DEX aggregator",
    headline: "Pass",
    variant: "verify",
    note: "Fed back into production /verify and confirmed PASS with independently-derived on-chain evidence — the same job returned UNVERIFIABLE before the mainnet migration, and correctly refused to guess.",
    evidenceLabel: "swap tx",
    txHash: "0x1f1b1e4edbe703e6a9bbf0f8aba431c0413b25362047c2aef61f3d65ae046697",
  },
];

function truncateHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

export function TrackRecord() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      ScrollTrigger.batch("[data-case]", {
        start: "top 85%",
        once: true,
        onEnter: (els) => gsap.to(els, { autoAlpha: 1, y: 0, duration: 0.55, ease: "power2.out", stagger: 0.1 }),
      });
    },
    { scope: rootRef },
  );

  return (
    <section id="track-record" ref={rootRef} className="border-b border-border/80 bg-ink-soft/40 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <header className="max-w-2xl">
          <p className="font-mono-data text-xs uppercase tracking-[0.2em] text-verify">Track record</p>
          <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Real money, real agents, real verdicts
          </h2>
          <p className="mt-4 max-w-2xl text-muted-foreground">
            Every case below happened on X Layer mainnet against third-party agents Vidimus has
            no relationship with, discovered on the open marketplace, paid with real funds.
          </p>
        </header>

        <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-2">
          {CASES.map((c) => (
            <article
              key={c.agent}
              data-case
              className="flex flex-col gap-5 rounded-lg border border-border/80 bg-background p-7 opacity-0 sm:flex-row sm:items-start"
              style={{ transform: "translateY(20px)" }}
            >
              <Stamp label={c.headline} variant={c.variant} size="sm" className="shrink-0" />
              <div className="min-w-0">
                <p className="font-heading text-lg font-semibold text-foreground">
                  {c.agent} <span className="font-mono-data text-sm font-normal text-muted-foreground">{c.agentId}</span>
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{c.what}</p>
                <p className="mt-3 text-sm leading-relaxed text-foreground/85">{c.note}</p>
                <p className="mt-4 font-mono-data text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                  {c.evidenceLabel}:{" "}
                  {c.txHash ? (
                    <a
                      href={`https://www.oklink.com/xlayer/tx/${c.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-verify underline decoration-verify-dim/60 underline-offset-2 hover:text-foreground"
                    >
                      {truncateHash(c.txHash)}
                    </a>
                  ) : (
                    <span className="text-foreground/80">block 35413618, X Layer mainnet</span>
                  )}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
