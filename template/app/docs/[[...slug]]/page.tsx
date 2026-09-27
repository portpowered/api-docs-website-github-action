import { notFound } from 'next/navigation';
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/page';
import { source } from '../../../lib/source';
import { openapi } from '../../../lib/openapi';
import { asyncapi } from '../../../lib/asyncapi';
import { OpenAPIPage, AsyncAPIPage } from '../../../components/api-page';
import { getMDXComponents } from '../../../components/mdx';

export function generateStaticParams() {
  return [{ slug: [] }, ...source.getPages().filter((page) => page.slugs.length > 0).map((page) => ({ slug: page.slugs }))];
}

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  const page = source.getPage(slug) ?? (slug.length === 0 ? source.getPage(['index']) : undefined);
  if (!page) notFound();
  const MDX = page.data.body;
  const contentComponents = getMDXComponents({
    OpenAPIPage: async (props: any) => {
      const schema = await openapi.getSchema(props.document);
      return <OpenAPIPage {...props} payload={{ bundled: schema.bundled }} />;
    },
    AsyncAPIPage: async (props: any) => {
      const schema = await asyncapi.getSchema(props.document);
      return <AsyncAPIPage {...props} payload={{ bundled: schema.bundled }} />;
    },
  });

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description && <DocsDescription>{page.data.description}</DocsDescription>}
      <DocsBody><MDX components={contentComponents} /></DocsBody>
    </DocsPage>
  );
}
