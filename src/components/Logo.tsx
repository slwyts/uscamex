import Image from "next/image";

export default function Logo({ className = "h-7" }: { className?: string }) {
  return (
    <div className={`flex items-center ${className}`}>
      <Image
        src="/images/logo.png"
        alt="USCAMEX"
        width={120}
        height={120}
        className="h-full w-auto object-contain"
        priority
      />
    </div>
  );
}
