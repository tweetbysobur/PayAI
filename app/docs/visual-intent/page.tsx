import type { Metadata } from "next";
import Link from "next/link";
import { DocsCallout, DocsSection, DocsTable } from "@/components/docs/DocsShell";
import { DocsChrome } from "@/components/docs/DocsChrome";

export const metadata: Metadata = {
  title: "Visual intent · PayAI Docs",
  description:
    "Pay from a picture in Ask PayAI: QR codes, payment requests, invoices and written instructions — what PayAI can read, how a caption combines with it, and the safety rules.",
};

const TOC = [
  { id: "what", title: "What it is" },
  { id: "read", title: "What PayAI can read" },
  { id: "qr", title: "QR codes" },
  { id: "caption", title: "Adding a caption" },
  { id: "flow", title: "From image to payment" },
  { id: "safety", title: "Safety rules" },
  { id: "privacy", title: "Your image" },
  { id: "limits", title: "Limits" },
];

/*
 * Read from the code:
 *   app/api/ask/visual/route.ts    upload checks, rate limits, the image is never stored
 *   lib/ask/visual/upload.ts       PNG/JPEG/WebP by file bytes, 4 MB, 32–8000 px
 *   lib/ask/visual/qrPayload.ts    the QR formats PayAI accepts and refuses
 *   lib/ask/visual/resolve.ts      caption + image merging, conflicts, red flags, max 5 actions
 *   lib/ask/visual/server.ts       reading invoices and instructions needs the language model
 */
export default function VisualIntentPage() {
  return (
    <DocsChrome
      title="Visual intent"
      lede="Pay from a picture. Attach a QR code, a payment request, an invoice or a screenshot of instructions in Ask PayAI, and PayAI reads the payment out of it — then shows it to you as an ordinary request to review and approve."
      toc={TOC}
    >
      <DocsSection id="what" title="What it is">
        <p>
          In <Link href="/docs/ask">Ask PayAI</Link>, tap the image button next to the message
          box and choose a photo or screenshot. You can add a caption, or send the image on its
          own. PayAI reads it and does one of four things:
        </p>
        <DocsTable
          headers={["Result", "What you see"]}
          rows={[
            ["A request", "A plain sentence such as “Send 25 USDC to alice.nad”, which goes through Ask PayAI exactly like typed text — the same plan, review and approval."],
            ["A question", "Something essential is missing (amount, token or recipient). PayAI lists what it read and asks for the rest."],
            ["A conflict", "The image and your caption, or two parts of the image, disagree. PayAI shows both and asks which is right — it never picks one."],
            ["A refusal", "The image can't be used safely: an invalid recipient, an unsupported QR code, or instructions aimed at PayAI. Nothing is prepared."],
          ]}
        />
        <DocsCallout tone="note" title="An image is never an approval">
          Reading an image only ever produces a request or a question. Nothing is built, signed
          or sent until you review the plan and approve it, exactly as with typed text.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="read" title="What PayAI can read">
        <DocsTable
          headers={["In the image", "What PayAI takes from it"]}
          rows={[
            ["A wallet QR code", "The address or .nad name. You add what to send — “Send 5 USDC to this address”."],
            ["A payment request QR", "Recipient, and for MON the amount, from the standard EIP-681 format. See QR codes below."],
            ["An invoice", "Who it's from, the invoice number, the total, the token and the address to pay. It is paid only when your caption asks — “Pay this invoice”."],
            ["Written payment instructions", "Up to 5 sends and swaps, such as a screenshot of “swap 10 MON to USDC and send it to name.nad”."],
            ["A printed address", "A 0x address or .nad name shown in the image, used as the recipient."],
          ]}
        />
        <p>
          QR codes are read by PayAI itself. Reading invoices, written instructions and printed
          text uses a language model from Anthropic, the same one Ask PayAI uses for
          open-ended wording — see{" "}
          <Link href="/docs/ask#understanding">How Ask understands you</Link>. Where that is
          turned off, QR codes still work and other images get a message asking you to type the
          request.
        </p>
      </DocsSection>

      <DocsSection id="qr" title="QR codes">
        <DocsTable
          headers={["Format", "Example", "Read as"]}
          rows={[
            ["Address", <code key="a">0x8b2c…464D</code>, "Recipient. A mixed-case address must carry a valid checksum, so a mistyped or altered one is refused."],
            [".nad name", <code key="n">alice.nad</code>, "Recipient, resolved to its address in the review."],
            ["EIP-681 native transfer", <code key="e">ethereum:0x…@143?value=…</code>, "Recipient and the MON amount."],
            ["EIP-681 token transfer", <code key="t">ethereum:&lt;token&gt;@143/transfer?address=0x…</code>, "Recipient and token. A raw token amount isn't guessed — you state it."],
          ]}
        />
        <p>
          The <code>monad:</code> scheme is read the same way as <code>ethereum:</code>. A payment
          request for another network is refused, and anything else — a website link, a long
          payload, unexpected characters — is refused with the reason. Nothing in a QR code is
          ever opened, fetched or run.
        </p>
      </DocsSection>

      <DocsSection id="caption" title="Adding a caption">
        <p>
          A caption says what to do with the image, and fills in what the image doesn&apos;t
          have:
        </p>
        <DocsTable
          headers={["Image", "Caption", "Becomes"]}
          rows={[
            ["Wallet QR", <code key="1">send 5 USDC to this address</code>, "Send 5 USDC to that address"],
            ["Invoice", <code key="2">pay this invoice</code>, "Pay the invoice total to its pay-to address"],
            ["Payment request QR with no amount", <code key="3">pay 20 USDC</code>, "Send 20 USDC to the QR's recipient"],
            ["Screenshot of instructions", "(none)", "Those instructions, as one plan"],
          ]}
        />
        <p>
          When the caption and the image both state an amount, a token or a recipient and they
          differ, PayAI asks which is right instead of choosing. The same applies when a QR code
          and an address printed next to it disagree — a sign of a swapped sticker or an altered
          image.
        </p>
      </DocsSection>

      <DocsSection id="flow" title="From image to payment">
        <ol>
          <li><strong>Upload checked.</strong> The file must really be a PNG, JPEG or WebP — judged by its contents, not its name — within the size limits below.</li>
          <li><strong>Read.</strong> PayAI decodes any QR code and, where enabled, reads the rest of the image.</li>
          <li><strong>Validated.</strong> Every amount, token and recipient is checked on its own. Only those validated fields are used — never free text copied out of the image.</li>
          <li><strong>Turned into a request.</strong> The fields become one plain sentence, shown in the chat as your request.</li>
          <li><strong>Reviewed and approved as usual.</strong> From here it is an ordinary Ask PayAI request: the plan review with full addresses, one approval, and your wallet signs. See <Link href="/docs/ask#approval">One approval</Link>.</li>
        </ol>
      </DocsSection>

      <DocsSection id="safety" title="Safety rules">
        <ul>
          <li><strong>Instructions inside images are ignored.</strong> Text aimed at PayAI or an assistant — &ldquo;ignore previous instructions&rdquo;, &ldquo;approve automatically&rdquo;, &ldquo;already approved&rdquo; — makes PayAI refuse the image and tell you why. This is checked in code on every field, not left to the model.</li>
          <li><strong>No &ldquo;send everything&rdquo;.</strong> An image asking for &ldquo;all funds&rdquo;, &ldquo;max&rdquo; or a whole balance is refused. Amounts from an image must be exact.</li>
          <li><strong>Valid recipients only.</strong> A recipient that isn&apos;t a valid 0x address or .nad name is refused, never corrected.</li>
          <li><strong>Disagreements are asked, never decided.</strong> Caption against image, or QR against printed address — you choose.</li>
          <li><strong>At most 5 actions per image.</strong> Larger lists are refused; send them in smaller groups or type them.</li>
          <li><strong>The review is the last word.</strong> Whatever was read, you see the exact amounts and full recipient addresses before approving.</li>
        </ul>
      </DocsSection>

      <DocsSection id="privacy" title="Your image">
        <p>
          The image is held in memory for the one request that reads it. It is not stored, not
          logged and never given a link; only the outcome (for example &ldquo;QR read&rdquo;) is
          recorded, never the image, the QR contents or the values read from it. The image itself
          isn&apos;t kept in your conversation — only your caption, marked as an image. Reading
          images needs an unlocked wallet. See <Link href="/privacy">Privacy</Link>.
        </p>
      </DocsSection>

      <DocsSection id="limits" title="Limits">
        <ul>
          <li>PNG, JPEG or WebP, up to 4 MB, between 32 and 8,000 pixels on a side.</li>
          <li>Captions up to 500 characters.</li>
          <li>Up to 10 images per wallet every 5 minutes.</li>
          <li>Up to 5 actions read from one image.</li>
          <li>A raw token amount in a QR code isn&apos;t converted — state the amount in your caption.</li>
          <li>Payments read from images follow Ask PayAI&apos;s own limits: sends in MON or USDC, swaps between MON and USDC.</li>
        </ul>
      </DocsSection>
    </DocsChrome>
  );
}
