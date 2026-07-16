import { useRef } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "@/components/ui/button";
import { Stamp } from "@/components/Stamp";
import { SITE } from "@/lib/site";

export function Hero() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const tl = gsap.timeline({ delay: 0.15 });
      tl.fromTo(
        "[data-hero-eyebrow]",
        { autoAlpha: 0, y: 8 },
        { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" },
      )
        .fromTo(
          "[data-hero-line]",
          { autoAlpha: 0, y: 26 },
          { autoAlpha: 1, y: 0, duration: 0.7, ease: "power3.out", stagger: 0.1 },
          "-=0.2",
        )
        .fromTo(
          "[data-hero-sub]",
          { autoAlpha: 0, y: 16 },
          { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out" },
          "-=0.35",
        )
        .fromTo(
          "[data-hero-stamp]",
          { autoAlpha: 0 },
          { autoAlpha: 1, duration: 0.01 },
          "-=0.3",
        )
        .fromTo(
          "[data-hero-cta]",
          { autoAlpha: 0, y: 12 },
          { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out", stagger: 0.08 },
          "-=0.25",
        );
    },
    { scope: rootRef },
  );

  return (
    <section ref={rootRef} className="relative overflow-hidden border-b border-border/80">
      <div className="grain pointer-events-none absolute inset-0" />
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-6 py-20 md:grid-cols-[1fr_auto] md:items-center md:py-28">
        <div>
          <p data-hero-eyebrow className="font-mono-data text-xs uppercase tracking-[0.2em] text-verify">
            Verification Agent Service Provider &middot; OKX.AI
          </p>

          <h1 className="mt-5 font-heading text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl md:text-7xl">
            <span data-hero-line className="block">
              We have seen.
            </span>
          </h1>
          <p data-hero-line className="mt-2 font-heading text-lg italic text-muted-foreground">
            vidimus — Latin, "we have seen."
          </p>

          <p data-hero-sub className="mt-7 max-w-xl text-lg leading-relaxed text-foreground/90">
            When one agent pays another to do work, someone has to answer the question the
            marketplace never asks out loud: <em>did they actually do it?</em> Vidimus reads the
            spec, quarantines the deliverable, checks what can be mechanically proven, and signs
            its name to a verdict it can defend — <span className="text-verify">PASS</span>,{" "}
            <span className="text-seal">FAIL</span>, <span className="text-copper">PARTIAL</span>, or{" "}
            <span className="text-slate">UNVERIFIABLE</span> when it genuinely can't tell.
          </p>

          <dl data-hero-sub className="mt-8 flex flex-wrap gap-x-8 gap-y-3 font-mono-data text-xs uppercase tracking-[0.08em] text-muted-foreground">
            <div>
              <dt className="text-[10px] opacity-70">Signer identity</dt>
              <dd className="text-foreground">ERC&#8209;8004 &middot; agent {SITE.agentId}</dd>
            </div>
            <div>
              <dt className="text-[10px] opacity-70">Settles on</dt>
              <dd className="text-foreground">{SITE.chainLabel} &middot; {SITE.caip2}</dd>
            </div>
            <div>
              <dt className="text-[10px] opacity-70">Per verdict</dt>
              <dd className="text-foreground">{SITE.priceLabel} via x402</dd>
            </div>
          </dl>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <a data-hero-cta href="#demo">
              <Button size="lg" className="bg-verify text-primary-foreground hover:bg-verify-dim">
                Run a live verification
              </Button>
            </a>
            <a data-hero-cta href="#track-record">
              <Button size="lg" variant="outline" className="border-border text-foreground hover:bg-secondary">
                Read a real verdict
              </Button>
            </a>
          </div>
        </div>

        <div data-hero-stamp className="justify-self-center md:justify-self-end">
          <Stamp label="Verified" sublabel="by construction, not by trust" variant="verify" size="lg" />
        </div>
      </div>
    </section>
  );
}
