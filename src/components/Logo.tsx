export default function Logo({ className = "h-7" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* USCAMEX Logo - World Cup themed icon */}
      <svg
        className="h-full w-auto"
        viewBox="0 0 36 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Soccer ball / globe hybrid */}
        <circle cx="18" cy="18" r="16" fill="#F5C842" />
        <circle cx="18" cy="18" r="14.5" fill="none" stroke="#0a0a0f" strokeWidth="0.5" opacity="0.3" />
        {/* Pentagon pattern (soccer ball) */}
        <path d="M18 4L22.5 10.5H13.5L18 4Z" fill="#0a0a0f" opacity="0.15" />
        <path d="M30 14L27 20.5L23 14.5L30 14Z" fill="#0a0a0f" opacity="0.15" />
        <path d="M6 14L13 14.5L9 20.5L6 14Z" fill="#0a0a0f" opacity="0.15" />
        <path d="M10 28L13 21.5H23L26 28L10 28Z" fill="#0a0a0f" opacity="0.15" />
        {/* Three color stripes - US/CA/MX */}
        <rect x="8" y="16" width="6" height="4" rx="1" fill="#3C3B6E" opacity="0.9" />
        <rect x="15" y="16" width="6" height="4" rx="1" fill="#FF0000" opacity="0.9" />
        <rect x="22" y="16" width="6" height="4" rx="1" fill="#006847" opacity="0.9" />
      </svg>
      {/* Text */}
      <span className="font-bold text-[1.1em] tracking-tight text-white leading-none">
        USCAMEX
      </span>
    </div>
  );
}
