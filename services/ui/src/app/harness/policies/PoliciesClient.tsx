'use client'

export default function PoliciesClient() {
  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Model Policies</h1>
        <p className="text-sm text-mountain-400 mt-1">
          Control which models your agents can access, with rate limits and token budgets.
        </p>
      </div>
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
        <p className="text-mountain-400 mb-2">Coming soon</p>
        <p className="text-sm text-mountain-500">
          Create policies that define allowed models, rate limits, and token budgets. Assign policies to agents to control their model access.
        </p>
      </div>
    </>
  )
}
