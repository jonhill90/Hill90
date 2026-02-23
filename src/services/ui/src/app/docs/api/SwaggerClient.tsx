'use client'

import dynamic from 'next/dynamic'

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false })

import 'swagger-ui-react/swagger-ui.css'

export default function SwaggerClient({ url }: { url: string }) {
  return (
    <div className="swagger-container">
      <SwaggerUI url={url} />
    </div>
  )
}
