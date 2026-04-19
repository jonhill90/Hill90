'use client'

import dynamic from 'next/dynamic'

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false })

import 'swagger-ui-react/swagger-ui.css'

export default function SwaggerClient({ url }: { url: string }) {
  return (
    <div className="swagger-dark">
      <SwaggerUI url={url} />
      <style jsx global>{`
        .swagger-dark .swagger-ui {
          background: transparent;
          color: #c9d1d9;
        }
        .swagger-dark .swagger-ui .info .title,
        .swagger-dark .swagger-ui .opblock-tag,
        .swagger-dark .swagger-ui h1, .swagger-dark .swagger-ui h2, .swagger-dark .swagger-ui h3, .swagger-dark .swagger-ui h4 {
          color: #e6edf3;
        }
        .swagger-dark .swagger-ui .info p,
        .swagger-dark .swagger-ui .info li,
        .swagger-dark .swagger-ui p,
        .swagger-dark .swagger-ui label,
        .swagger-dark .swagger-ui .opblock-description-wrapper p,
        .swagger-dark .swagger-ui table thead tr th,
        .swagger-dark .swagger-ui table thead tr td,
        .swagger-dark .swagger-ui .parameter__name,
        .swagger-dark .swagger-ui .parameter__type,
        .swagger-dark .swagger-ui .response-col_status,
        .swagger-dark .swagger-ui .response-col_description,
        .swagger-dark .swagger-ui .model-title,
        .swagger-dark .swagger-ui .model {
          color: #c9d1d9;
        }
        .swagger-dark .swagger-ui .info a,
        .swagger-dark .swagger-ui a {
          color: #6db33a;
        }
        .swagger-dark .swagger-ui .scheme-container,
        .swagger-dark .swagger-ui .opblock .opblock-section-header {
          background: #1a2332;
          border-color: #2d3f54;
        }
        .swagger-dark .swagger-ui .opblock {
          background: #0f1923;
          border-color: #2d3f54;
        }
        .swagger-dark .swagger-ui .opblock .opblock-summary {
          border-color: #2d3f54;
        }
        .swagger-dark .swagger-ui .opblock-body pre,
        .swagger-dark .swagger-ui .highlight-code {
          background: #0d1117 !important;
          color: #c9d1d9;
        }
        .swagger-dark .swagger-ui .opblock-body pre span {
          color: #c9d1d9 !important;
        }
        .swagger-dark .swagger-ui .model-box,
        .swagger-dark .swagger-ui section.models {
          background: #0f1923;
          border-color: #2d3f54;
        }
        .swagger-dark .swagger-ui section.models h4 {
          border-color: #2d3f54;
        }
        .swagger-dark .swagger-ui .topbar {
          display: none;
        }
        .swagger-dark .swagger-ui .btn.authorize {
          color: #6db33a;
          border-color: #6db33a;
        }
        .swagger-dark .swagger-ui .btn.authorize svg {
          fill: #6db33a;
        }
        .swagger-dark .swagger-ui select {
          background: #1a2332;
          color: #c9d1d9;
          border-color: #2d3f54;
        }
        .swagger-dark .swagger-ui input[type=text],
        .swagger-dark .swagger-ui textarea {
          background: #0d1117;
          color: #c9d1d9;
          border-color: #2d3f54;
        }
        .swagger-dark .swagger-ui .opblock-tag {
          border-color: #2d3f54;
        }
        .swagger-dark .swagger-ui .opblock-tag:hover {
          background: #1a2332;
        }
        .swagger-dark .swagger-ui table tbody tr td {
          border-color: #2d3f54;
          color: #c9d1d9;
        }
        .swagger-dark .swagger-ui .response-col_links {
          color: #c9d1d9;
        }
        .swagger-dark .swagger-ui .wrapper {
          padding: 0;
        }
      `}</style>
    </div>
  )
}
