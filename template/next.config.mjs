import { createMDX } from 'fumadocs-mdx/next';
import site from './lib/site-config.json' with { type: 'json' };

const withMDX = createMDX();
export default withMDX({
  output: 'export',
  trailingSlash: true,
  basePath: site.basePath,
  images: { unoptimized: true },
});
