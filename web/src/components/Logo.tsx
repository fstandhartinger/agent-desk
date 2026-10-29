/** Agent Desk mark: a stage frame with the three explainer accents. */
export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lg-desk" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#63D297" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="#16161d" stroke="url(#lg-desk)" strokeWidth="1.5" />
      <circle cx="11" cy="16" r="4" fill="#63D297" />
      <circle cx="20" cy="11.5" r="2.6" fill="#FA5D19" />
      <circle cx="21.5" cy="20.5" r="3.2" fill="#8B5CF6" />
      <path d="M14.6 14.6 L18 12.6 M14.8 17.6 L18.6 19.6" stroke="#ecebf3" strokeOpacity=".35" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
