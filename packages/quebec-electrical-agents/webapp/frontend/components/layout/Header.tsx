/**
 * Application header with branding and navigation.
 */

import { Zap, Settings, Info } from "lucide-react";

export default function Header() {
  return (
    <header className="border-b border-border bg-card/50 backdrop-blur-sm">
      <div className="flex items-center justify-between px-6 py-4">
        {/* Logo and branding */}
        <div className="flex items-center gap-3">
          <div className="relative">
            <Zap className="w-8 h-8 text-cyber-blue animate-pulse-glow" />
            <div className="absolute inset-0 w-8 h-8">
              <Zap className="w-8 h-8 text-cyber-purple opacity-50 blur-sm" />
            </div>
          </div>
          <div>
            <h1 className="text-xl font-bold heading-gradient">
              Agents Électriques Québec
            </h1>
            <p className="text-xs text-muted-foreground">
              Système PGI • CEQ • RBQ • RSST • CSA
            </p>
          </div>
        </div>

        {/* Status indicators */}
        <div className="flex items-center gap-4">
          {/* Backend status */}
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse-glow" />
            <span className="text-sm text-muted-foreground">Backend Online</span>
          </div>

          {/* Settings button */}
          <button
            className="p-2 rounded-md hover:bg-muted transition-colors"
            aria-label="Settings"
          >
            <Settings className="w-5 h-5" />
          </button>

          {/* Info button */}
          <button
            className="p-2 rounded-md hover:bg-muted transition-colors"
            aria-label="About"
          >
            <Info className="w-5 h-5" />
          </button>
        </div>
      </div>
    </header>
  );
}
