import DOMPurify from "dompurify";
import { marked } from "marked";

const allowedTags = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

const allowedAttributes = ["href", "title"];

export function renderMarkdown(markdown: string) {
  const html = marked.parse(markdown, { async: false }) as string;
  const sanitizedHtml = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttributes,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?):|#)/i,
    RETURN_TRUSTED_TYPE: false,
  });

  const template = document.createElement("template");
  template.innerHTML = sanitizedHtml;
  template.content.querySelectorAll("a[href]").forEach((link) => {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
  });

  return template.innerHTML;
}
