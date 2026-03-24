import puppeteer from '@cloudflare/puppeteer';
import { normalizeUrl } from 'crux-api';
import { getEntity } from 'third-party-web';

const DEBUG_PARAM = '__debug';

const pushLimited = (arr, item, limit = 50) => {
	if (arr.length < limit) arr.push(item);
};

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
		return data?.result || null;
	});

	return Promise.all(promises);
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const greencheck = async (ips = [], delayMs = 200, concurrency = 2) => {
	const base = 'https://api.thegreenwebfoundation.org/api/v3/greencheck/';

	if (ips.length === 0) return [];

	const results = new Array(ips.length);
	let index = 0;

	const limit = Math.max(1, Math.min(concurrency, ips.length));

	const worker = async () => {
		while (true) {
			const current = index++;
			if (current >= ips.length) return;

			const ip = ips[current];

			try {
				const response = await fetch(`${base}${ip}`);
				const data = await response.json();
				results[current] = data;
			} catch {
				console.error(`Failed to fetch greencheck for ${ip}`);
				throw new Error(`Failed to fetch greencheck for ${ip}`);
			} finally {
				// Wait between requests to avoid rate limiting
				await delay(delayMs);
			}
		}
	};

	await Promise.all(Array.from({ length: limit }, () => worker()));

	return results;
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
		hostIpAddress,
	};

	return summary;
};

export default {
	async fetch(request, env) {
		const timestamp = Date.now();
		const runLocation = { colo: request.cf.colo, city: request.cf.city, country: request.cf.country };
		const requestUrl = new URL(request.url);
		const queryURL = requestUrl.searchParams.get('url');
		const debugToken = env.DEBUG_TOKEN;
		const debugParamValue = requestUrl.searchParams.get(DEBUG_PARAM);
		const debug = Boolean(debugToken && debugParamValue === debugToken);
		const nocache = requestUrl.searchParams.get('nocache') === 'true' ? true : false;
		const cacheKey = `${runLocation.colo}-${queryURL}`;
		const cache = env.CACHE;
		const shouldUseCache = !nocache && !debug;

		if (shouldUseCache) {
			const cachedResponse = await cache.get(cacheKey);
			if (cachedResponse) {
				const json = JSON.parse(cachedResponse);
				json.cache = true;
				return Response.json(json);
			}
		}

		if (!queryURL) {
			return new Response('Missing URL parameter', { status: 400 });
		}

		const sanitizedURL = normalizeUrl(queryURL);

		if (!new URL(sanitizedURL).protocol.startsWith('http')) {
			return new Response('Invalid URL protocol', { status: 400 });
		}

		const browser = await puppeteer.launch(env.MYBROWSER, { keep_alive: 120000 });

		const debugInfo = {
			enabled: debug,
			navigation: null,
			console: [],
			pageErrors: [],
			requestFailures: [],
			networkFailures: [],
		};

		const debugLog = (message, data) => {
			if (debug) console.log(`[debug] ${message}`, data ?? '');
		};

		try {
			const page = await browser.newPage();
			const client = await page.target().createCDPSession();
			await page.setViewport({ width: 1920, height: 1080 });
			const requestsById = new Map();

			page.on('console', (msg) => {
				pushLimited(debugInfo.console, { type: msg.type(), text: msg.text() });
			});

			page.on('pageerror', (error) => {
				pushLimited(debugInfo.pageErrors, { message: error?.message || String(error) });
			});

			page.on('requestfailed', (req) => {
				const failure = req.failure();
				pushLimited(debugInfo.requestFailures, {
					url: req.url(),
					method: req.method(),
					failure: failure ? failure.errorText : 'unknown',
				});
			});

			client.on('Network.loadingFailed', (evt) => {
				pushLimited(debugInfo.networkFailures, {
					requestId: evt.requestId,
					errorText: evt.errorText,
					canceled: evt.canceled,
					type: evt.type,
				});
			});

			client.on('Network.responseReceived', ({ requestId, response }) => {
				requestsById.set(requestId, {
					url: response.url,
					ipAddress: response.remoteIPAddress || null,
				});
			});

			await client.send('Network.enable');
			const navigationStart = Date.now();
			const waitUntil = 'networkidle2';
			const timeoutMs = 120000;
			try {
				await page.goto(sanitizedURL, {
					waitUntil,
					timeout: timeoutMs,
				});
				debugInfo.navigation = {
					status: 'success',
					waitUntil,
					timeoutMs,
					durationMs: Date.now() - navigationStart,
				};
			} catch (error) {
				const message = error?.message || String(error);
				debugInfo.navigation = {
					status: 'error',
					waitUntil,
					timeoutMs,
					durationMs: Date.now() - navigationStart,
					message,
				};
				debugLog('Navigation failed', debugInfo.navigation);
				const isTimeout = error?.name === 'TimeoutError' || /Navigation timeout/i.test(message);
				if (!isTimeout) {
					throw error;
				}
			}

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

			const uniqueIpAddresses = Array.from(new Set(enrichedRequests.map((req) => req.ipAddress).filter(Boolean)));
			const hostIpAddress = enrichedRequests[0]?.ipAddress || null;
			const thirdPartyRequests = enrichedRequests
				.filter((value, index, self) => index === self.findIndex((t) => t.ipAddress === value.ipAddress))
				.filter((req) => req.ipAddress && req.ipAddress !== hostIpAddress);

			const ipInfo = await ipLocLookup(env, uniqueIpAddresses);
			const greenInfo = await greencheck(uniqueIpAddresses);
			const thirdPartyInfo = await thirdPartyLookup(thirdPartyRequests);

			const requestInfo = enrichedRequests.map((req) => ({
				...req,
				ipInfo: ipInfo.find((info) => info?.ip?.ip === req.ipAddress)?.ip || null,
				greencheck: greenInfo.find((info) => info.url === req.ipAddress) || null,
				thirdParty: thirdPartyInfo.find((info) => info.url === req.url) || {},
				gridData: ipInfo.find((info) => info?.ip?.ip === req.ipAddress)?.gridData || null,
			}));

			const buffer = await page.screenshot();

			const response = {
				cache: false,
				data: requestInfo,
				summary: generateSummary(enrichedRequests, uniqueIpAddresses, thirdPartyRequests, greenInfo, hostIpAddress),
				runDetails: { timestamp, location: runLocation, screenshot: buffer.toString('base64') },
			};

			if (debug) {
				response.debug = debugInfo;
			}

			// Cache for 7 days
			if (shouldUseCache) {
				await cache.put(cacheKey, JSON.stringify(response), { expirationTtl: 604800 });
			}
			return Response.json(response);
		} catch (error) {
			if (debug) {
				debugInfo.error = {
					message: error?.message || String(error),
					stack: error?.stack || null,
				};
				return Response.json({ error: 'Request failed', message: error?.message || String(error), debug: debugInfo }, { status: 500 });
			}
			throw error;
		} finally {
			await browser.close();
		}
	},
};
