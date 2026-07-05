import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CraftAgentsSymbol } from "./icons/CraftAgentsSymbol"
import { BRAND, APP_VERSION } from "@craft-agent/shared/branding"
import { ExternalLink } from "lucide-react"

interface AboutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  const version = APP_VERSION

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-0 p-0 overflow-hidden">
        <DialogHeader className="sr-only">
          <DialogTitle>{BRAND.appName}</DialogTitle>
        </DialogHeader>

        {/* Logo + Name */}
        <div className="flex flex-col items-center pt-8 pb-4 px-6">
          <CraftAgentsSymbol className="size-16 mb-4" />
          <h2 className="text-lg font-semibold">{BRAND.appName}</h2>
          {version && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Version {version}
            </p>
          )}
        </div>

        {/* Credits */}
        {BRAND.creditsEntries.length > 0 && (
          <div className="px-6 pb-6">
            <p className="text-xs text-muted-foreground text-center mb-3">
              {BRAND.creditsShort}
            </p>
            <div className="space-y-2">
              {BRAND.creditsEntries.map((entry) => (
                <a
                  key={entry.name}
                  href={entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2.5 text-sm hover:bg-accent/5 transition-colors group"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{entry.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {entry.role}
                    </div>
                  </div>
                  <ExternalLink className="size-3.5 text-muted-foreground shrink-0 ml-2 opacity-0 group-hover:opacity-100 transition-opacity" />
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Copyright */}
        <div className="border-t border-border/50 px-6 py-3">
          <p className="text-[11px] text-muted-foreground text-center">
            {BRAND.copyright}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
