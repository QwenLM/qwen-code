/**
 * Chat panel component with SSE streaming support.
 *
 * Features:
 * - Real-time message streaming from backend
 * - Automatic PGI data detection
 * - Message history
 * - Loading states
 */

"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2 } from "lucide-react";
import { Message, Artifact, PGIData } from "@/types/artifact";
import MessageBubble from "./MessageBubble";

interface ChatPanelProps {
  onArtifactReceived: (artifact: Artifact) => void;
}

export default function ChatPanel({ onArtifactReceived }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Bonjour! Je suis votre assistant IA pour les projets électriques au Québec. Comment puis-je vous aider aujourd'hui?",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /**
   * Send message and stream response from backend.
   */
  const handleSendMessage = async () => {
    if (!input.trim() || isStreaming) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsStreaming(true);

    // Create assistant message placeholder
    const assistantMessageId = (Date.now() + 1).toString();
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, assistantMessage]);

    try {
      // Prepare messages for API
      const apiMessages = messages
        .concat(userMessage)
        .map((m) => ({ role: m.role, content: m.content }));

      // Stream response
      abortControllerRef.current = new AbortController();

      const response = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          temperature: 0.7,
          max_tokens: 2000,
          detect_pgi: true,
          model: "gpt-4-turbo-preview",
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No response body");
      }

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim() || !line.startsWith("data: ")) continue;

          const data = line.slice(6); // Remove "data: "

          try {
            const parsed = JSON.parse(data);

            if (parsed.type === "text") {
              // Append text chunk
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessageId
                    ? { ...m, content: m.content + parsed.content }
                    : m
                )
              );
            } else if (parsed.type === "pgi") {
              // PGI data received - create artifact
              const pgiData: PGIData = parsed.data;
              const artifact: Artifact = {
                id: Date.now().toString(),
                type: "pgi_dashboard",
                title: pgiData.title,
                content: pgiData,
                createdAt: new Date().toISOString(),
              };

              // Attach to current message
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessageId ? { ...m, artifact } : m
                )
              );

              // Send to artifact panel
              onArtifactReceived(artifact);
            } else if (parsed.type === "done") {
              // Stream completed
              break;
            } else if (parsed.type === "error") {
              throw new Error(parsed.message);
            }
          } catch (e) {
            console.error("Error parsing SSE data:", e);
          }
        }
      }
    } catch (error: any) {
      if (error.name !== "AbortError") {
        console.error("Error streaming message:", error);

        // Show error message
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId
              ? {
                  ...m,
                  content: `Erreur: ${error.message || "Impossible de communiquer avec le serveur"}`,
                }
              : m
          )
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  /**
   * Handle Enter key to send message.
   */
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  /**
   * Stop streaming response.
   */
  const handleStopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsStreaming(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Chat header */}
      <div className="px-6 py-4 border-b border-border">
        <h2 className="text-lg font-semibold">Chat Assistant</h2>
        <p className="text-sm text-muted-foreground">
          Posez des questions sur vos projets électriques
        </p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            onArtifactClick={
              message.artifact
                ? () => onArtifactReceived(message.artifact!)
                : undefined
            }
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="px-6 py-4 border-t border-border">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Tapez votre message..."
            className="cyber-input flex-1"
            disabled={isStreaming}
          />

          {isStreaming ? (
            <button
              onClick={handleStopStreaming}
              className="cyber-button-secondary px-4 flex items-center gap-2"
              aria-label="Stop streaming"
            >
              <div className="w-4 h-4 bg-current rounded-sm" />
              Stop
            </button>
          ) : (
            <button
              onClick={handleSendMessage}
              disabled={!input.trim()}
              className="cyber-button px-4 flex items-center gap-2"
              aria-label="Send message"
            >
              <Send className="w-4 h-4" />
              Envoyer
            </button>
          )}
        </div>

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>L'assistant réfléchit...</span>
          </div>
        )}
      </div>
    </div>
  );
}
