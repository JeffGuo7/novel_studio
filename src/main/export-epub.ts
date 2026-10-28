/**
 * EPUB 3 打包：把章节 XHTML 组装成最小但合规的 EPUB。
 *
 * 结构：
 *   mimetype（第一个条目、不压缩）
 *   META-INF/container.xml
 *   OEBPS/content.opf / nav.xhtml / style.css / chapter-XXXX.xhtml
 */
import crypto from 'node:crypto'
import { ZipFile } from 'yazl'
import { chapterXhtml, escapeHtml, type ExportBook } from '../core'

function modifiedTime(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function buildEpub(book: ExportBook): Promise<Buffer> {
  const zip = new ZipFile()
  const chunks: Buffer[] = []
  zip.outputStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
  const finished = new Promise<void>((resolve, reject) => {
    zip.outputStream.on('end', () => resolve())
    zip.outputStream.on('error', reject)
  })

  const uuid = crypto.randomUUID()
  const chapterFiles = book.chapters.map((chapter) => ({
    id: `chapter-${chapter.key}`,
    fileName: `chapter-${chapter.key}.xhtml`,
    chapter,
  }))

  // EPUB 规范：mimetype 必须是第一个条目且不压缩
  zip.addBuffer(Buffer.from('application/epub+zip', 'utf8'), 'mimetype', { compress: false })

  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
      'utf8',
    ),
    'META-INF/container.xml',
  )

  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="css" href="style.css" media-type="text/css"/>',
    ...chapterFiles.map(
      (item) => `    <item id="${item.id}" href="${item.fileName}" media-type="application/xhtml+xml"/>`,
    ),
  ].join('\n')
  const spine = chapterFiles.map((item) => `    <itemref idref="${item.id}"/>`).join('\n')

  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeHtml(book.title)}</dc:title>
    <dc:creator>${escapeHtml(book.author)}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${modifiedTime()}</meta>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>
`,
      'utf8',
    ),
    'OEBPS/content.opf',
  )

  const navItems = book.chapters
    .map(
      (chapter, index) =>
        `        <li><a href="${chapterFiles[index].fileName}">第 ${chapter.number} 章 ${escapeHtml(chapter.title)}</a></li>`,
    )
    .join('\n')
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>目录</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>
`,
      'utf8',
    ),
    'OEBPS/nav.xhtml',
  )

  zip.addBuffer(
    Buffer.from(
      `body { font-family: "Songti SC", "SimSun", serif; line-height: 1.9; margin: 1.5em; }
h1, h2, h3 { font-family: "Songti SC", "SimSun", serif; line-height: 1.4; }
p { text-indent: 2em; margin: 0.6em 0; }
blockquote { margin: 1em 2em; color: #444; }
`,
      'utf8',
    ),
    'OEBPS/style.css',
  )

  for (const item of chapterFiles) {
    zip.addBuffer(Buffer.from(chapterXhtml(item.chapter), 'utf8'), `OEBPS/${item.fileName}`)
  }

  zip.end()
  await finished
  return Buffer.concat(chunks)
}
