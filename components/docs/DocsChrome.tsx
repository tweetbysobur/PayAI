import { headers } from "next/headers";
import { DocsShell, type DocsShellProps } from "@/components/docs/DocsShell";
import { APP_ORIGIN, isDocsHost } from "@/lib/hosts";

/** Server wrapper so docs links know whether this request is docs.usepayai.xyz. */
export async function DocsChrome(props: Omit<DocsShellProps, "onDocsHost" | "appOrigin">) {
  const host = (await headers()).get("host") ?? "";
  return <DocsShell {...props} onDocsHost={isDocsHost(host)} appOrigin={APP_ORIGIN} />;
}
