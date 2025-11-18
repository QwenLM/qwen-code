/**
 * Message bubble component for chat messages.
 */

import { Message } from "@/types/artifact";
import { User, Bot, FileText } from "lucide-react";
import { format } from "date-fns";

interface MessageBubbleProps {
  message: Message;
  onArtifactClick?: () => void;
}

export default function MessageBubble({ message, onArtifactClick }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div
        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          isUser ? "bg-cyber-purple/20" : "bg-cyber-blue/20"
        }`}
      >
        {isUser ? (
          <User className="w-5 h-5 text-cyber-purple" />
        ) : (
          <Bot className="w-5 h-5 text-cyber-blue" />
        )}
      </div>

      {/* Message content */}
      <div className={`flex-1 max-w-[80%] ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-lg p-4 ${
            isUser
              ? "bg-cyber-purple/10 border border-cyber-purple/30"
              : "bg-cyber-blue/10 border border-cyber-blue/30"
          }`}
        >
          {/* Text content */}
          <div className="whitespace-pre-wrap break-words">{message.content}</div>

          {/* Artifact badge */}
          {message.artifact && (
            <button
              onClick={onArtifactClick}
              className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md bg-accent/20 border border-accent/50 hover:bg-accent/30 transition-colors"
            >
              <FileText className="w-4 h-4 text-accent" />
              <span className="text-sm font-medium text-accent">
                {message.artifact.type === "pgi_dashboard"
                  ? "📊 Tableau de Bord PGI"
                  : message.artifact.type === "plan_with_photos"
                  ? "📸 Plan avec Photos"
                  : "Voir l'artefact"}
              </span>
            </button>
          )}
        </div>

        {/* Timestamp */}
        <div className="mt-1 px-1 text-xs text-muted-foreground">
          {format(new Date(message.timestamp), "HH:mm")}
        </div>
      </div>
    </div>
  );
}
