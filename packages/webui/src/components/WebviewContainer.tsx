import type { PropsWithChildren } from 'react';
import type React from 'react';

interface WebviewContainerProps extends PropsWithChildren {
  className?: string;
}

/**
 * A container component that provides style isolation for VSCode webviews
 * This component wraps content in a namespace to prevent style conflicts
 */
const WebviewContainer: React.FC<WebviewContainerProps> = ({
  children,
  className = '',
}) => <div className={`qwen-webui-container ${className}`}>{children}</div>;

export default WebviewContainer;
