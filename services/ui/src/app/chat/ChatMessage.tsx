'use client'

import { Bot, User, AlertCircle, Loader2 } from 'lucide-react'
import type { Message } from './ChatView'

interface Props {
  message: Message
  isOwnMessage: boolean
}

export default function ChatMessage({ message, isOwnMessage }: Props) {
  const isUser = message.role === 'user'
  const isPending = message.status === 'pending'
  const isError = message.status === 'error'

  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
          isUser ? 'bg-brand-600/30' : 'bg-navy-700'
        }`}
      >
        {isUser ? (
          <User size={14} className="text-brand-400" />
        ) : (
          <Bot size={14} className="text-mountain-400" />
        )}
      </div>

      {/* Bubble */}
      <div
        className={`max-w-[75%] rounded-xl px-3.5 py-2.5 ${
          isUser
            ? 'bg-brand-600/20 border border-brand-600/30'
            : isError
            ? 'bg-red-900/20 border border-red-800/30'
            : 'bg-navy-800 border border-navy-700'
        }`}
      >
        {isPending ? (
          <div className="flex items-center gap-2 text-mountain-400">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-sm italic">Thinking...</span>
          </div>
        ) : isError ? (
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm text-red-400">
                {message.error_message || 'An error occurred'}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-200 whitespace-pre-wrap break-words">
            {message.content}
          </p>
        )}

        {/* Metadata for assistant messages */}
        {!isUser && message.status === 'complete' && (message.model || message.duration_ms) && (
          <div className="flex items-center gap-2 mt-1.5 text-xs text-mountain-500">
            {message.model && <span>{message.model}</span>}
            {message.duration_ms != null && (
              <span>{(message.duration_ms / 1000).toFixed(1)}s</span>
            )}
            {message.input_tokens != null && message.output_tokens != null && (
              <span>{message.input_tokens + message.output_tokens} tok</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
