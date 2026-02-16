import puppeteer from '@cloudflare/puppeteer';
import { normalizeUrl } from 'crux-api';
import { getEntity } from 'third-party-web';

const resolveHostToIp = async (hostname) => {
	const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`, {
		headers: { Accept: 'application/dns-json' },
	});
	const data = await response.json();
	const aRecord = data.Answer?.find((r) => r.type === 1); // Type 1 = A record

	return aRecord?.data || null;
};

const ipLocLookup = async (env, ips = []) => {
	const apiKey = env.CF_RADAR_API;
	const baseUrl = 'https://api.cloudflare.com/client/v4/radar/entities/ip?ip=';
	const headers = {
		Authorization: `Bearer ${apiKey}`,
	};

	const promises = ips.map(async (ip) => {
		const response = await fetch(`${baseUrl}${ip}`, { headers });
		const data = await response.json();
		return data.result?.ip || null;
	});

	return Promise.all(promises);
};

const greencheck = async (ips = []) => {
	const base = 'https://api.thegreenwebfoundation.org/api/v3/greencheck/';

	const promises = ips.map(async (ip) => {
		const response = await fetch(`${base}${ip}`);
		const data = await response.json();
		return data;
	});

	return Promise.all(promises);
};

const thirdPartyLookup = async (requests = []) => {
	const promises = requests.map(async (req) => {
		const response = await getEntity(req.url);
		return { url: req.url, ...response };
	});

	return Promise.all(promises);
};

const generateSummary = (networkRequests, uniqueIpAddresses, thirdPartyRequests, greenInfo, hostIpAddress) => {
	// total requests
	const totalRequests = networkRequests.length;

	// uniqueIpAddresses (unique hosts)
	const uniqueHosts = uniqueIpAddresses.length;

	// thirdParties (unique third-party hosts)
	const tpIpAddresses = [...new Set(thirdPartyRequests.map((req) => req.ipAddress))];
	const thirdPartyHosts = tpIpAddresses.filter((ip) => ip !== hostIpAddress).length;

	// GWF Verified third thirdParties
	const verifiedThirdParties = greenInfo.filter((info) => info.green && tpIpAddresses.includes(info.url)).length;

	const summary = {
		totalRequests,
		uniqueHosts,
		thirdPartyHosts,
		verifiedThirdParties,
	};

	return summary;
};

export default {
	async fetch(request, env) {
		const runLocation = { city: request.cf.city, country: request.cf.country };
		const queryURL = new URL(request.url).searchParams.get('url');

		if (!queryURL) {
			return new Response('Missing URL parameter', { status: 400 });
		}

		const sanitizedURL = normalizeUrl(queryURL);

		if (!new URL(sanitizedURL).protocol.startsWith('http')) {
			return new Response('Invalid URL protocol', { status: 400 });
		}

		const browser = await puppeteer.launch(env.MYBROWSER, { keep_alive: 600000 });

		try {
			const page = await browser.newPage();
			const client = await page.target().createCDPSession();
			const requestsById = new Map();

			client.on('Network.responseReceived', ({ requestId, response }) => {
				requestsById.set(requestId, {
					url: response.url,
					ipAddress: response.remoteIPAddress || null,
				});
			});

			await client.send('Network.enable');
			await page.goto(sanitizedURL);

			const networkRequests = Array.from(requestsById.values()).filter((req) => req.ipAddress !== null);

			// Deduplicate hostnames
			const hostnames = [...new Set(networkRequests.map((r) => new URL(r.url).hostname))];

			// Resolve all hostnames to IPs
			const hostnameToIp = new Map();
			await Promise.all(
				hostnames.map(async (hostname) => {
					const ip = await resolveHostToIp(hostname);
					if (ip) hostnameToIp.set(hostname, ip);
				}),
			);

			// Attach the resolved IP to each request
			const enrichedRequests = networkRequests.map((req) => ({
				...req,
				ipAddress: hostnameToIp.get(new URL(req.url).hostname) || null,
			}));

			const uniqueIpAddresses = Array.from(new Set(enrichedRequests.map((req) => req.ipAddress)));
			const hostIpAddress = enrichedRequests[0].ipAddress;
			const thirdPartyRequests = enrichedRequests
				.filter((value, index, self) => index === self.findIndex((t) => t.ipAddress === value.ipAddress))
				.filter((req) => req.ipAddress !== hostIpAddress);

			console.log(thirdPartyRequests);

			const ipInfo = await ipLocLookup(env, uniqueIpAddresses);
			const greenInfo = await greencheck(uniqueIpAddresses);
			const thirdPartyInfo = await thirdPartyLookup(thirdPartyRequests);

			const requestInfo = enrichedRequests.map((req) => ({
				...req,
				ipInfo: ipInfo.find((info) => info?.ip === req.ipAddress) || null,
				greencheck: greenInfo.find((info) => info.url === req.ipAddress)?.hosted_by || null,
				thirdParty: thirdPartyInfo.find((info) => info.url === req.url) || null,
			}));

			return Response.json({
				data: requestInfo,
				summary: generateSummary(enrichedRequests, uniqueIpAddresses, thirdPartyRequests, greenInfo, hostIpAddress),
				runLocation: runLocation,
			});
		} finally {
			await browser.close();
		}
	},
};
