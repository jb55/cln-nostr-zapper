#!/usr/bin/env node

const {RelayPool, Relay, signId, calculateId, getPublicKey} = require('nostr')
const fs = require('fs').promises
const {spawn} = require('node:child_process')

function relay_send(ev, url, opts) {
	const timeout = (opts && opts.timeout != null && opts.timeout) || 5000

	return new Promise((resolve, reject) => {
		const relay = Relay(url)

		function timeout_reached() {
			relay.close()
			reject(new Error("Request timeout"))
		}

		let timer = setTimeout(timeout_reached, timeout)

		relay.on('open', () => {
			clearTimeout(timer)
			timer = setTimeout(timeout_reached, timeout)
			relay.send(['EVENT', ev])
		})

		relay.on('ok', (evid, ok, msg) => {
			clearTimeout(timer)
			relay.close()
			resolve({evid, ok, msg})
		})
	})
}

async function send_note(urls, {privkey, pubkey}, ev)
{
	try {
		const tasks = urls.map(relay_send.bind(null, ev))
		await Promise.all(tasks)
	} catch (e) {
		//log?
		console.log(e)
	}
}

function get_tipreq(desc) {
	if (!desc)
		return null

	if (desc.kind === 9734)
		return desc

	// TODO: handle private zaps

	// This is a deprecated old form, you don't need this
	const found = desc.find(tag => tag && tag.length >= 2 && tag[0] == "application/nostr")
	if (found && found[1])
		return found[1]

	return null
}

async function process_invoice_payment(privkey, invoice)
{
	const pubkey = getPublicKey(privkey)
	const keypair = {privkey, pubkey}
	// Parse the invoice metadata
	let desc
	try {
		desc = JSON.parse(invoice.description)
	} catch {
		//log(`Could not parse description as json`)
		return
	}
	const label = invoice.label
	if (!desc) {
		//log(`Could not parse metadata description as json for ${label}`)
		return
	}
	// Get the nostr note entry in the metadata
	const tipreq = get_tipreq(desc)
	if (!tipreq) {
		//log(`Could not find application/nostr note in metadata for ${label}`)
		return
	}

	// Make sure there are tags on the note
	if (!tipreq.tags || tipreq.tags.length === 0) {
		console.log(`No tags found in ${label}`)
		return
	}
	// Make sure we only have one p tag
	const ptags = tipreq.tags.filter(t => t && t.length && t.length >= 2 && t[0] === "p")
	if (ptags.length !== 1) {
		console.log(`None or multiple p tags found in ${label}`)
		return
	}
	// Make sure we have 0 or 1 etag (for note tipping)
	const etags = tipreq.tags.filter(t => t && t.length && t.length >= 2 && t[0] === "e")
	if (!(etags.length === 0 || etags.length === 1)) {
		console.log(`Expected none or 1 e tags in ${label}`)
		return
	}
	// Look for the relays tag, we will broadcast to these relays
	const relays_tag = tipreq.tags.find(t => t && t.length && t.length >= 2 && t[0] === "relays")
	if (!relays_tag) {
		console.log(`No relays tag found in ${label}`)
		return
	}

	const relays = relays_tag.slice(1)
	const ptag = ptags[0]
	const etag = etags.length > 0 && etags[0]
	const data = {ptag, tipreq, invoice, keypair, ptag, etag}
	const tip_note = await make_tip_note(data)
	await send_note(relays, keypair, tip_note)

	console.log(`Sent lightning tip note ${tip_note.id} to ${relays.join(", ")}`)
}

async function make_tip_note({keypair, invoice, tipreq, ptag, etag}) {
	const kind = 9735
	const created_at = invoice.paid_at
	const pubkey = keypair.pubkey
	const privkey = keypair.privkey
	const content = tipreq.content

	let tags = [ ptag ]
	if (etag)
		tags.push(etag)

	tags.push(["bolt11", invoice.bolt11])
	tags.push(["description", invoice.description])
	tags.push(["preimage", invoice.payment_preimage])

	let ev = {pubkey, kind, created_at, content, tags}

	ev.id = await calculateId(ev)
	ev.sig = await signId(privkey, ev.id)

	return ev
}

async function get_invoice(label)
{
	const {invoices} = await callrpc("listinvoices", {label})
	return invoices && invoices[0]
}

function dospawn(cmd, ...args)
{
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, [...args])
		proc.stdout.on('data', (data) => {
			resolve(data.toString("utf8").trim())
		})
		proc.on('close', code => {
			resolve(code)
		});
	})
}


async function callrpc(rpc, args) {
	const params = Object.keys(args).map(key => `${key}=${args[key]}`)
	const res = await dospawn("lightning-cli", rpc, params)
	return JSON.parse(res)
}

async function waitanyinvoice(index) {
	const res = await callrpc("waitanyinvoice", index)
	return res
}

async function run_zapper(args) {
	const privkey = process.env.NOSTR_KEY
	if (!privkey) {
		console.log("set NOSTR_KEY")
		return
	}
	let lastpay_index = parseInt(args[0]) || await read_lastpay_index()
	while (true) {
		const params = {lastpay_index}
		const invoice = await waitanyinvoice(params)
		await process_invoice_payment(privkey, invoice)
		lastpay_index += 1
		await write_lastpay_index(lastpay_index)
	}
}

const lastpay_file = "tip_lastpay_index"

async function read_lastpay_index() {
	try {
		const res = await fs.readFile(lastpay_file, 'utf8')
		return parseInt(res)
	} catch {
		return 0
	}
}

async function write_lastpay_index(lastpay_index) {
	await fs.writeFile(lastpay_file, lastpay_index.toString())
}


run_zapper(process.argv.slice(2))
