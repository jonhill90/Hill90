# Provider Icons — Provenance

SVG path data sourced from third-party icon libraries for use as inline React SVG components in `provider-icons.tsx`.

## Sources

| Provider | Source | License | URL |
|----------|--------|---------|-----|
| OpenAI | LobeHub lobe-icons | MIT | https://github.com/lobehub/lobe-icons/blob/master/packages/react-native/src/icons/OpenAI/components/Mono.tsx |
| Anthropic | Simple Icons | CC0-1.0 | https://github.com/simple-icons/simple-icons/blob/develop/icons/anthropic.svg |
| Google | LobeHub lobe-icons | MIT | https://github.com/lobehub/lobe-icons/blob/master/packages/react-native/src/icons/Google/components/Mono.tsx |
| Mistral | LobeHub lobe-icons | MIT | https://github.com/lobehub/lobe-icons/blob/master/packages/react-native/src/icons/Mistral/components/Mono.tsx |
| Cohere | LobeHub lobe-icons | MIT | https://github.com/lobehub/lobe-icons/blob/master/packages/react-native/src/icons/Cohere/components/Mono.tsx |
| Azure | LobeHub lobe-icons | MIT | https://github.com/lobehub/lobe-icons/blob/master/packages/react-native/src/icons/Azure/components/Mono.tsx |
| Default | Hand-crafted | N/A | Minimal circle-dot fallback for unknown providers |

All icons use `viewBox="0 0 24 24"` and `fill="currentColor"` for CSS-driven coloring.
Azure paths had `fillOpacity` attributes removed for full contrast on dark backgrounds.

OpenAI is not available in Simple Icons; LobeHub lobe-icons (MIT) is used as the source.
Simple Icons project: https://simpleicons.org — CC0-1.0 (public domain dedication).
