/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';

interface MessageProps {
  id: string;
  content: string;
  sender: 'user' | 'system' | 'assistant';
  timestamp?: Date;
  className?: string;
}

const Message: FC<MessageProps> = ({
  content,
  sender,
  timestamp,
  className = '',
}) => {
  const alignment = sender === 'user' ? 'justify-end' : 'justify-start';
  const bgColor = sender === 'user' ? 'bg-blue-500' : 'bg-gray-200';

  return (
    <div className={`flex ${alignment} mb-4 ${className}`}>
      <div
        className={`${bgColor} text-white rounded-lg px-4 py-2 max-w-xs md:max-w-md lg:max-w-lg`}
      >
        {content}
        {timestamp && (
          <div className="text-xs opacity-70 mt-1">
            {timestamp.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default Message;
