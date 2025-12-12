"use client";

import { useState } from "react";
import ChatPanel from "@/components/chat/ChatPanel";
import ArtifactPanel from "@/components/artifact/ArtifactPanel";
import Header from "@/components/layout/Header";
import { Artifact } from "@/types/artifact";

/**
 * Main application page with split-pane layout.
 *
 * Layout:
 * - Header (top)
 * - Split pane:
 *   - Chat panel (left, resizable)
 *   - Artifact panel (right)
 */
export default function Home() {
  // Chat and artifact state
  const [currentArtifact, setCurrentArtifact] = useState<Artifact | null>(null);

  // Split pane state
  const [leftWidth, setLeftWidth] = useState(50); // percentage

  // Handle split pane resize
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();

    const startX = e.clientX;
    const startLeftWidth = leftWidth;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startX;
      const containerWidth = window.innerWidth;
      const deltaPercent = (deltaX / containerWidth) * 100;
      const newLeftWidth = Math.max(30, Math.min(70, startLeftWidth + deltaPercent));
      setLeftWidth(newLeftWidth);
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "default";
      document.body.style.userSelect = "auto";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <Header />

      {/* Main split-pane layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat Panel */}
        <div
          className="overflow-y-auto border-r border-border"
          style={{ width: `${leftWidth}%` }}
        >
          <ChatPanel onArtifactReceived={setCurrentArtifact} />
        </div>

        {/* Divider */}
        <div
          className="split-divider"
          onMouseDown={handleMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
        />

        {/* Right: Artifact Panel */}
        <div
          className="flex-1 overflow-y-auto"
          style={{ width: `${100 - leftWidth}%` }}
        >
          <ArtifactPanel artifact={currentArtifact} />
        </div>
      </div>
    </div>
  );
}
