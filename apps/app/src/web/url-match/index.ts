import { fileURLToPath } from "url";
import type { Vault, TFile, App } from "obsidian";
import { FileSystemAdapter, normalizePath } from "obsidian";
import { addTempFrag, removeTempFrag } from "@/lib/hash/format";
import { parseTempFrag, type TempFragment } from "@/lib/hash/temporal-frag";
import path from "@/lib/path";
import { noHash } from "@/lib/url";
import { mediaInfoFromFile } from "@/media-view/media-info";
import type { MediaInfo } from "@/media-view/media-info";
import { checkMediaType, type MediaType } from "@/patch/media-type";
import type { MxSettings } from "@/settings/def";
import type { URLResolveResult, URLResolver } from "./base";
import { bilibiliDetecter, bilibiliResolver } from "./bilibili";
import { courseraDetecter, courseraResolver } from "./coursera";
import { genericResolver } from "./generic";
import { MediaHost } from "./supported";
import { vimeoDetecter, vimeoResolver } from "./vimeo";
import { youtubeDetecter, youtubeResolver } from "./youtube";

const allowedProtocols = new Set(["https:", "http:", "file:"]);

export class MediaURL extends URL implements URLResolveResult {
  static create(url: string | URL, mx?: URL | string): MediaURL | null {
    if (url instanceof MediaURL) {
      return url.clone();
    }
    try {
      return new MediaURL(url, mx);
    } catch {
      return null;
    }
  }

  get inferredType(): MediaType | null {
    const ext = this.pathname.split(".").pop();
    if (!ext) return null;
    return checkMediaType(ext);
  }

  get isFileUrl(): boolean {
    return this.protocol === "file:";
  }
  get filePath(): string | null {
    if (this.isFileUrl) {
      try {
        return fileURLToPath(this);
      } catch (e) {
        console.error("Failed to convert file url to path", e, this.href);
        return null;
      }
    }
    return null;
  }

  getVaultFile(vault: Vault): TFile | null {
    if (!(vault.adapter instanceof FileSystemAdapter)) return null;
    const filePath = this.filePath;
    const vaultBasePath = vault.adapter.getBasePath();
    if (!filePath) return null;
    const relative = path.relative(vaultBasePath, filePath);
    if (/^\.\.[/\\]/.test(relative) || path.isAbsolute(relative)) return null;
    const normalized = normalizePath(relative);
    return vault.getFileByPath(normalized);
  }

  compare(other: MediaURL | null | undefined): boolean {
    return !!other && this.jsonState.source === other.jsonState.source;
  }

  /**
   * Print the url with temporal fragment encoded (if supported)
   * @returns the url without hash
   */
  print(frag?: TempFragment): string {
    if (this.mxUrl) return noHash(this.mxUrl.href);
    if (!frag) return this.jsonState.source;
    if (this.#resolved.print) return this.#resolved.print(frag);
    return this.jsonState.source;
  }

  get tempFrag(): TempFragment | null {
    return parseTempFrag(this.hash);
  }
  // get isTimestamp(): boolean {
  //   return !!this.tempFrag && isTimestamp(this.tempFrag);
  // }

  // setHash(hash: string | ((hash: string) => string)): MediaURL {
  //   const prevHash = this.hash.replace(/^#+/, "");
  //   const newHash =
  //     typeof hash === "string" ? hash.replace(/^#+/, "") : hash(prevHash);
  //   if (newHash === prevHash) return this;
  //   const newURL = this.clone();
  //   newURL.hash = newHash;
  //   return newURL;
  // }
  setTempFrag(tempFrag: TempFragment | null): MediaURL {
    const newUrl = this.clone();
    const notf = removeTempFrag(this.hash);
    if (!tempFrag) {
      newUrl.hash = notf;
    } else {
      newUrl.hash = addTempFrag(notf, tempFrag);
    }
    return newUrl;
  }

  clone() {
    return new MediaURL(this, this.mxUrl ?? undefined);
  }

  get readableHref() {
    return decodeURI(this.href);
  }

  #resolved: URLResolveResult;

  get source() {
    return this.#resolved.source;
  }
  get cleaned(): URL {
    return this.#resolved.cleaned;
  }
  get id(): string | undefined {
    return this.#resolved.id;
  }
  readonly type: MediaHost;

  get jsonState(): { source: string; hash: string } {
    return {
      source: noHash(this.mxUrl ?? this.cleaned),
      hash: addTempFrag(this.hash, this.#resolved.tempFrag),
    };
  }

  mxUrl: URL | null;
  constructor(original: string | URL, mx?: URL | string) {
    super(original);
    this.mxUrl = mx ? new URL(mx) : null;
    if (!allowedProtocols.has(this.protocol))
      throw new Error("Unsupported protocol: " + this.protocol);
    this.type =
      detecters.reduce<MediaHost | null>(
        (prev, detect) => prev ?? detect(this),
        null,
      ) ?? MediaHost.Generic;
    this.#resolved = Resolver[this.type](this);
  }
}

const detecters = [
  bilibiliDetecter,
  youtubeDetecter,
  vimeoDetecter,
  courseraDetecter,
];
// eslint-disable-next-line @typescript-eslint/naming-convention
const Resolver: Record<MediaHost, URLResolver> = {
  [MediaHost.Bilibili]: bilibiliResolver,
  [MediaHost.YouTube]: youtubeResolver,
  [MediaHost.Vimeo]: vimeoResolver,
  [MediaHost.Coursera]: courseraResolver,
  [MediaHost.Generic]: genericResolver,
};

export function resolveUrl(url: MediaURL): URLResolveResult {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return genericResolver(url);
  }
  for (const resolve of [
    bilibiliResolver,
    youtubeResolver,
    vimeoResolver,
    courseraResolver,
  ]) {
    const result = resolve(url);
    if (result) return result;
  }
  return genericResolver(url);
}

export function resolveMxProtocol(
  src: URL | null,
  { getUrlMapping }: MxSettings,
  app: App,
): MediaInfo | null {
  if (!src) return null;
  if (src.protocol !== "mx:") return checkInVault(src);

  // custom protocol take // as part of the pathname
  const [, , mxProtocol] = src.pathname.split("/");
  const replace = getUrlMapping(mxProtocol);
  if (!replace) return null;
  return checkInVault(
    src.href.replace(`mx://${mxProtocol}/`, replace.replace(/\/*$/, "/")),
    src,
  );

  function checkInVault(url: string | URL, mx?: string | URL) {
    const media = MediaURL.create(url, mx);
    if (!media) return null;
    if (!media.isFileUrl) return media;
    const file = media.getVaultFile(app.vault);
    if (!file) {
      if (media.inferredType === null) return null;
      return media;
    }
    if (checkMediaType(file.extension) === null) return null;
    return mediaInfoFromFile(file, media.hash);
  }
}

// export function fromFile(info: FileMediaInfo, vault: Vault): MediaURL {
//   const resouceUrl = vault.getResourcePath(info.file);
//   return new MediaURL(
//     "file:///" +
//       resouceUrl.substring(Platform.resourcePathPrefix.length) +
//       "#" +
//       info.hash,
//   );
// }
