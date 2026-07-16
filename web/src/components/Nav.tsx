import { SITE } from "@/lib/site";

export function Nav() {
  return (
    <header className="relative z-20 border-b border-border/80">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 64 64" className="h-7 w-7 shrink-0" aria-hidden>
            <circle cx="32" cy="32" r="30" fill="var(--ink)" stroke="var(--verify)" strokeWidth="2.5" />
            <text x="32" y="42" fontFamily="var(--font-heading)" fontSize="30" fontWeight="600" fill="var(--paper)" textAnchor="middle">
              V
            </text>
          </svg>
          <span className="font-heading text-lg font-semibold tracking-tight text-foreground">Vidimus</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono-data text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
          <span>
            Case No. <span className="text-foreground">AGENT&#8209;{SITE.agentId}</span>
          </span>
          <span className="hidden sm:inline text-border">/</span>
          <span className="hidden sm:inline">{SITE.chainLabel}</span>
          <span className="hidden sm:inline text-border">/</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-verify opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-verify" />
            </span>
            <span className="text-verify">Live</span>
          </span>
        </div>

        <nav className="flex items-center gap-4 font-mono-data text-[11px] uppercase tracking-[0.1em]">
          <a href="#registry" className="text-muted-foreground transition-colors hover:text-foreground">
            Evidence
          </a>
          <a href="#demo" className="text-muted-foreground transition-colors hover:text-foreground">
            Try it
          </a>
          <a href="#track-record" className="text-muted-foreground transition-colors hover:text-foreground">
            Track record
          </a>
          <a
            href={SITE.githubUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
