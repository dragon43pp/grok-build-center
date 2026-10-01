import { useMemo } from 'react'
import { renderSVG } from 'uqr'

/**
 * 飞书扫码用的二维码。
 *
 * 和 `RemoteJoinQr` 是同一套做法：`uqr` 出一个纯 SVG 字符串，直接 inline 进
 * DOM —— 没有 canvas、没有网络请求、没有图片文件。
 *
 * ⚠️ `[&>svg]:*` 那几项**不是装饰，是让二维码显示出来的唯一原因**。
 * `renderSVG` 出来的 SVG 只有 `viewBox`、**没有 width/height 属性**，不给它
 * 定尺寸就塌成 0×0：外层容器因为有 padding 仍有约 10×10 的盒子，
 * 于是「元素存在、尺寸非零」，肉眼却什么都看不到 —— 2026-09-30 实际踩过，
 * 而且当时的端到端判卷只断言了「元素存在」，一路绿灯。
 * 改这里之前先想想 `RemoteJoinQr` 为什么也这么写。
 *
 * `data-qr-url` 是给端到端测试用的抓手：它带着**未经渲染**的原始地址，
 * 测试可以断言「二维码里编的确实是那个 URL」，而不是只看到一张图。
 * 但注意光有这个抓手不够 —— 还要断言 SVG **真的被渲染出了尺寸**，
 * 否则就是「地址是对的，码是看不见的」。
 */
export default function FeishuScanQr({ url }: { url: string }) {
  const svg = useMemo(
    () =>
      renderSVG(url, {
        pixelSize: 4,
        border: 4,
        whiteColor: '#ffffff',
        blackColor: '#111111'
      }),
    [url]
  )
  return (
    <div
      data-testid="settings-feishu-qr"
      data-qr-url={url}
      // 飞书这个地址比远程配对的长得多（addons 是一大段 base64），模块数到 356，
      // 比 `RemoteJoinQr` 那 200px 的盒子密得多 —— 给大一点，手机才好扫。
      className="inline-block w-[260px] max-w-full overflow-hidden rounded-lg border border-border-default bg-white p-2 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
