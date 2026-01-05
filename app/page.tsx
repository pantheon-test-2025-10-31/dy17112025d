import Image from "next/image";
import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-blue-900">
      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-between py-32 px-16 bg-white dark:bg-blue-900 sm:items-start">
        <Image
          className="dark:invert"
          src="/next.svg"
          alt="Next.js logo"
          width={100}
          height={20}
          priority
        />
        <div className="flex flex-col items-center gap-6 text-center sm:items-start sm:text-left">
          <h1 className="max-w-xs text-3xl font-semibold leading-10 tracking-tight text-black dark:text-zinc-50">
            This is the updated title with an upstream update. This is a new new update.
          </h1>
          <p className="max-w-md text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            Looking for a starting point or more instructions? Head over to{" "}
            <a
              href="https://vercel.com/templates?framework=next.js&utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
              className="font-medium text-zinc-950 dark:text-zinc-50"
            >
              Templates. This should cause a conflict
            </a>{" "}
            or the{" "}
            <a
              href="https://nextjs.org/learn?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
              className="font-medium text-zinc-950 dark:text-zinc-50"
            >
              Learning
            </a>{" "}
            center.
          </p>
        </div>
        <div className="flex flex-col gap-3 text-base font-medium sm:grid sm:grid-cols-2 lg:flex lg:flex-row lg:flex-wrap">
          <Link
            className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-black/[.08] px-5 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a] lg:w-[150px]"
            href="/blogs"
          >
            Blogs (ISR)
          </Link>
          <Link
            className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-black/[.08] px-5 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a] lg:w-[150px]"
            href="/about"
          >
            About (SSR)
          </Link>
          <Link
            className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-purple-600/20 px-5 transition-colors hover:border-purple-600 hover:bg-purple-600/10 dark:border-purple-400/20 dark:hover:border-purple-400 dark:hover:bg-purple-400/10 lg:w-[150px] text-purple-600 dark:text-purple-400"
            href="/ssg-demo"
          >
            SSG Demo
          </Link>
          <Link
            className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-blue-600/20 px-5 transition-colors hover:border-blue-600 hover:bg-blue-600/10 dark:border-blue-400/20 dark:hover:border-blue-400 dark:hover:bg-blue-400/10 lg:w-[150px] text-blue-600 dark:text-blue-400"
            href="/cache-test"
          >
            Cache Test
          </Link>
          <Link
            className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-black/[.08] px-5 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a] lg:w-[150px]"
            href="https://nextjs.org/docs?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
            target="_blank"
            rel="noopener noreferrer"
          >
            Docs
          </Link>
        </div>
      </main>
    </div>
  );
}
