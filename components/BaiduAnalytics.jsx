'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import Script from 'next/script';

/* 百度统计（官方异步代码，经 next/script afterInteractive 注入，不阻塞渲染）。
   本站是 Next.js 客户端路由：hm.js 只在首次加载时自动上报一次 PV，站内
   <Link> 跳转不会再触发，所以这里监听 pathname 变化手动 _trackPageview；
   首次渲染跳过（hm.js 已自动上报，补一条会双计）。_hmt 在脚本加载前 push
   只是入队，hm.js 加载后会重放队列。更换统计站点时替换下方 hm.js 的 ID。 */
export default function BaiduAnalytics() {
  const pathname = usePathname();
  const autoTrackedRef = useRef(false);

  useEffect(() => {
    if (!autoTrackedRef.current) {
      autoTrackedRef.current = true;
      return;
    }
    (window._hmt ||= []).push(['_trackPageview', pathname]);
  }, [pathname]);

  return (
    <Script id="baidu-hm" strategy="afterInteractive">
      {`var _hmt = _hmt || [];
(function() {
  var hm = document.createElement("script");
  hm.src = "https://hm.baidu.com/hm.js?40806123f42f801d2bcf3546380095c1";
  var s = document.getElementsByTagName("script")[0];
  s.parentNode.insertBefore(hm, s);
})();`}
    </Script>
  );
}
