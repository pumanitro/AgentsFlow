import type { AgentProvider } from '../../shared/types';

/**
 * The two agent providers, as marks rather than words.
 *
 * Monochrome and `currentColor` on purpose: these sit inline in headers, pills
 * and menu rows that already carry their own colour (accent when selected,
 * muted when not), so the icon has to take the colour of whatever it is in
 * rather than fight it with brand paint.
 *
 * Both are simplified from the real logos — an "A" of two slanted strokes and a
 * crossbar for Anthropic, a six-petal blossom for OpenAI — because at 13–14px
 * the fine detail of either mark turns to mush.
 */
export function providerName(provider: AgentProvider): 'Claude' | 'Codex' {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

// Six identical petals, each a rounded bar from the centre outwards, rotated a
// sixth of a turn apart.
const PETALS = [0, 60, 120, 180, 240, 300];

export default function ProviderIcon({
  provider,
  size = 14,
  className,
  title,
}: {
  provider: AgentProvider;
  size?: number;
  className?: string;
  title?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    className: `shrink-0 ${className ?? ''}`.trim(),
    role: title ? ('img' as const) : undefined,
    'aria-hidden': title ? undefined : (true as const),
  };

  if (provider === 'codex') {
    return (
      <svg {...common}>
        {title && <title>{title}</title>}
        <g>
          {PETALS.map((deg) => (
            <rect
              key={deg}
              x="10.7"
              y="2.2"
              width="2.6"
              height="10.3"
              rx="1.3"
              transform={`rotate(${deg} 12 12)`}
            />
          ))}
        </g>
      </svg>
    );
  }

  return (
    <svg {...common}>
      {title && <title>{title}</title>}
      {/* Left slant */}
      <path d="M10.1 2.6h3.8L7.6 21.4H3.8z" />
      {/* Right slant */}
      <path d="M10.1 2.6h3.8l6.3 18.8h-3.8z" />
      {/* Crossbar */}
      <path d="M7.6 12.4h8.8l1.2 3.4H6.4z" />
    </svg>
  );
}
