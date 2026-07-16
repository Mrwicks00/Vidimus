import { useRef } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { cn } from "@/lib/utils";

export type StampVariant = "verify" | "seal" | "copper" | "slate";

const VARIANT_STYLE: Record<StampVariant, { border: string; text: string; halo: string }> = {
  verify: { border: "border-verify", text: "text-verify", halo: "bg-verify" },
  seal: { border: "border-seal", text: "text-seal", halo: "bg-seal" },
  copper: { border: "border-copper", text: "text-copper", halo: "bg-copper" },
  slate: { border: "border-slate", text: "text-slate", halo: "bg-slate" },
};

interface StampProps {
  label: string;
  sublabel?: string;
  variant: StampVariant;
  size?: "sm" | "lg";
  /** Increment to replay the stamp-down animation (e.g. when a new verdict arrives). */
  playKey?: number;
  className?: string;
}

export function Stamp({ label, sublabel, variant, size = "lg", playKey = 0, className }: StampProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const style = VARIANT_STYLE[variant];
  const dims = size === "lg" ? "h-40 w-40 md:h-48 md:w-48" : "h-24 w-24";

  useGSAP(
    () => {
      const el = rootRef.current;
      if (!el) return;
      const tl = gsap.timeline({ defaults: { ease: "power2.out" } });
      tl.fromTo(
        el,
        { scale: 2.2, rotate: -22, autoAlpha: 0, filter: "blur(5px)" },
        { scale: 1, rotate: -7, autoAlpha: 1, filter: "blur(0px)", duration: 0.45, ease: "back.out(2.4)" },
      )
        .to(el, { scale: 1.04, duration: 0.08, ease: "power1.out" })
        .to(el, { scale: 1, duration: 0.16, ease: "power2.out" })
        .fromTo(
          el.querySelector("[data-halo]"),
          { autoAlpha: 0.55, scale: 0.85 },
          { autoAlpha: 0, scale: 1.35, duration: 0.6, ease: "power1.out" },
          "<",
        );
    },
    { scope: rootRef, dependencies: [playKey], revertOnUpdate: true },
  );

  return (
    <div ref={rootRef} className={cn("relative inline-flex select-none", className)}>
      <div data-halo className={cn("absolute inset-0 rounded-full blur-md opacity-0", style.halo)} aria-hidden />
      <div
        className={cn(
          "relative flex flex-col items-center justify-center rounded-full border-[3px] text-center",
          "font-heading uppercase tracking-[0.08em]",
          dims,
          style.border,
          style.text,
        )}
        style={{ rotate: "-7deg" }}
      >
        <span className="absolute inset-2 rounded-full border border-dashed opacity-40" style={{ borderColor: "currentColor" }} aria-hidden />
        <span className={cn(size === "lg" ? "text-2xl md:text-3xl" : "text-base", "font-semibold leading-none")}>{label}</span>
        {sublabel ? (
          <span className="mt-1.5 max-w-[85%] font-mono-data text-[9px] font-medium uppercase tracking-[0.12em] opacity-80">
            {sublabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
