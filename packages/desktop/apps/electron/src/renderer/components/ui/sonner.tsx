import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/context/ThemeContext"

// Empty fragment to hide all toast icons
const NoIcon = () => <></>

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedMode } = useTheme()

  return (
    <Sonner
      theme={resolvedMode as ToasterProps["theme"]}
      position="top-right"
      closeButton
      richColors={false}
      swipeDirections={["right"]}
      className="toaster group"
      icons={{
        success: <NoIcon />,
        info: <NoIcon />,
        warning: <NoIcon />,
        error: <NoIcon />,
        loading: <NoIcon />,
      }}
      toastOptions={{
        className: "!rounded-xl !backdrop-blur-xl group",
      }}
      style={
        {
          "--normal-bg": "transparent",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "transparent",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
