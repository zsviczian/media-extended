import { parseLinktext } from "obsidian";
import { MEDIA_FILE_VIEW_TYPE } from "@/media-view/view-type";
import type MxPlugin from "@/mx-main";
import { checkMediaType } from "@/patch/utils";

export async function onInternalLinkClick(
  this: MxPlugin,
  linktext: string,
  sourcePath: string,
  newLeaf: boolean,
  fallback: () => void,
) {
  const { metadataCache } = this.app;
  const { path: linkpath, subpath } = parseLinktext(linktext);
  const linkFile = metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
  let mediaType;
  if (!linkFile || !(mediaType = checkMediaType(linkFile.extension))) {
    fallback();
    return;
  }
  const mediaInfo = {
    file: linkFile,
    hash: subpath,
    type: mediaType,
    viewType: MEDIA_FILE_VIEW_TYPE[mediaType],
  };
  await this.leafOpener.openMedia(mediaInfo, newLeaf);
}
