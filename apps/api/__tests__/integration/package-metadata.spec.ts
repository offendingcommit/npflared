import { SELF } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "#db/index";
import { validators } from "#routers/package/validators";
import packagePublishPayload from "../mocks/package-publish-payload.json";
import { createToken } from "../utils";

describe("package metadata tarball URLs", () => {
	it.each([
		{
			name: "@scope/mock",
			metadataPath: "/@scope%2fmock",
			tarballPath: "/@scope/mock/-/@scope/mock-1.0.0.tgz"
		},
		{ name: "mock", metadataPath: "/mock", tarballPath: "/mock/-/mock-1.0.0.tgz" }
	])("serves $name from the request origin without changing the stored release", async ({
		name,
		metadataPath,
		tarballPath
	}) => {
		const attachment = packagePublishPayload._attachments["mock-1.0.0.tgz"];
		const payload = validators.put.request.json.parse({
			...packagePublishPayload,
			_id: name,
			name,
			"dist-tags": { latest: "1.0.0", next: "1.0.0" },
			versions: {
				"1.0.0": {
					...packagePublishPayload.versions["1.0.0"],
					_id: `${name}@1.0.0`,
					name,
					customMetadata: { preserved: true },
					dist: {
						...packagePublishPayload.versions["1.0.0"].dist,
						tarball: `http://publisher.example${tarballPath}`
					}
				}
			},
			_attachments: { [`${name}-1.0.0.tgz`]: attachment }
		});
		const { token: writeToken } = await createToken({
			name: "publisher",
			scopes: [{ type: "package:write", values: [name] }]
		});
		const { token: readToken } = await createToken({
			name: "consumer",
			scopes: [{ type: "package:read", values: [name] }]
		});
		const publishUrl = `https://registry.example:8443${metadataPath}`;
		const publishRequest = {
			method: "PUT",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeToken}` },
			body: JSON.stringify(payload)
		};
		const published = await SELF.fetch(publishUrl, publishRequest);
		expect(published.status).toBe(200);
		await published.text();

		const storedRelease = await db.query.packageReleaseTable.findFirst({
			where: (table, { eq }) => eq(table.package, name)
		});
		expect(storedRelease?.manifest).toEqual(payload.versions["1.0.0"]);

		// Both reads use the immutable HTTP manifest already persisted by putPackage.
		for (const origin of ["https://registry.example:8443", "https://replacement.example"]) {
			const response = await SELF.fetch(`${origin}${metadataPath}`, {
				headers: {
					Authorization: `Bearer ${readToken}`,
					"X-Forwarded-Host": "publisher.example",
					"X-Forwarded-Proto": "http"
				}
			});
			expect(response.status).toBe(200);
			const metadata = validators.get.response[200].parse(await response.json());
			expect(metadata["dist-tags"]).toEqual(payload["dist-tags"]);
			const manifest = validators.put.request.json.shape.versions.valueType.parse(metadata.versions["1.0.0"]);
			expect(metadata.versions).toEqual({
				"1.0.0": {
					...payload.versions["1.0.0"],
					dist: { ...packagePublishPayload.versions["1.0.0"].dist, tarball: `${origin}${tarballPath}` }
				}
			});
			const tarball = await SELF.fetch(manifest.dist.tarball, {
				headers: { Authorization: `Bearer ${readToken}` }
			});
			expect(tarball.status).toBe(200);
			const bytes = Buffer.from(await tarball.arrayBuffer());
			expect(bytes).toEqual(Buffer.from(attachment.data, "base64"));
			expect(`sha512-${createHash("sha512").update(bytes).digest("base64")}`).toBe(manifest.dist.integrity);
			expect(createHash("sha1").update(bytes).digest("hex")).toBe(manifest.dist.shasum);

			for (const url of [`${origin}${metadataPath}`, manifest.dist.tarball]) {
				const anonymous = await SELF.fetch(url);
				expect(anonymous.status).toBe(403);
				await anonymous.text();
			}
		}

		const deniedPublish = await SELF.fetch(publishUrl, {
			...publishRequest,
			headers: { ...publishRequest.headers, Authorization: `Bearer ${readToken}` }
		});
		expect(deniedPublish.status).toBe(403);
		await deniedPublish.text();
		const unchangedRelease = await db.query.packageReleaseTable.findFirst({
			where: (table, { eq }) => eq(table.package, name)
		});
		expect(unchangedRelease).toEqual(storedRelease);
	});
});
