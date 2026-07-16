import { SITE } from "@/lib/site";

export function Footer() {
  return (
    <footer className="py-16">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-col gap-8 border-b border-border/80 pb-10 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <p className="font-heading text-xl font-semibold text-foreground">Vidimus</p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              A signed, evidence-backed verification agent for the agent economy. Consume the
              substrate, build the brain — OKX provides payment, identity, and chain access;
              the judgment is ours.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-10 gap-y-6 font-mono-data text-xs uppercase tracking-[0.1em] text-muted-foreground sm:grid-cols-3">
            <div className="flex flex-col gap-2">
              <p className="text-foreground/70">Read</p>
              <a href={SITE.githubUrl} target="_blank" rel="noreferrer" className="hover:text-foreground">
                GitHub
              </a>
              <a href={`${SITE.githubUrl}#the-verdict-object`} target="_blank" rel="noreferrer" className="hover:text-foreground">
                Verdict spec
              </a>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-foreground/70">Identity</p>
              <span className="normal-case text-foreground/80">ERC-8004 #{SITE.agentId}</span>
              <span>{SITE.chainLabel}</span>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-foreground/70">Market</p>
              <a href={SITE.okxAgentUrl} target="_blank" rel="noreferrer" className="hover:text-foreground">
                OKX.AI
              </a>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-3 font-mono-data text-[11px] uppercase tracking-[0.1em] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>TypeScript · Hono · viem · Anthropic API · X Layer mainnet · OKX Onchain OS</p>
          <p className="italic normal-case tracking-normal opacity-70">vidimus — we have seen.</p>
        </div>
      </div>
    </footer>
  );
}
