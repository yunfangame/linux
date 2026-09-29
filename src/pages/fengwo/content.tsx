import { openUrl } from '@tauri-apps/plugin-opener'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'

export function RichText({ children }: { children: string }) {
  return (
    <Markdown
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={{
        a: ({ href, children: label }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              if (href && /^https?:\/\//i.test(href))
                void openUrl(href).catch(() => {})
            }}
          >
            {label}
          </a>
        ),
      }}
    >
      {children}
    </Markdown>
  )
}
