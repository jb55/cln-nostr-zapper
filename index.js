#!/usr/bin/env node

const {RelayPool, Relay, signId, calculateId, getPublicKey} = require('nostr')
const Plugin = require('clightningjs')
const plugin = new Plugin()
const {spawn} = require('node:child_process')

const TESTING = true
let log = TESTING ? console.log : log_error_file
let callrpc = TESTING ? clirpc : plugin.rpc.call


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
		log(e)
	}
}

function decode(bolt11) {
	return plugin.rpc.call("decode", {string:bolt11})
}

async function plugin_init(params) {
	const privkey = params.options['nostr-key']

	broadcast = async (params) => {
		const evName = Object.keys(params)[0]
		if (evName !== 'invoice_payment')
			return

		try {
			await process_invoice_payment(privkey, params)
		} catch (e) {
			return log(e)
		}
	  }
}

function validate_note(id, note)
{
	const tags = note.tags
	if (note.kind !== 9734)
		return false
	if (!tags)
		return false
	if (tags.length === 0)
		return false
	// Ensure that we at least have a p tag
	if (!tags.find(t => t && t.length >= 2 && t[0] === "p"))
		return false
	if (tag.length < 2)
		return false
	return tag[1] === id
}

async function process_invoice_payment(privkey, params)
{
	const pubkey = getPublicKey(privkey)
	const keypair = {privkey, pubkey}
	const {label} = params
	if (!label)
		return
        const invoice = await get_invoice(label)
	if (!invoice) {
		log(`Could not find invoice ${label}`)
		return
	}
	// Parse the invoice metadata
	const desc = JSON.parse(invoice.description)
	if (!desc) {
		log(`Could not parse metadata description as json for ${label}`)
		return
	}
	// Get the nostr note entry in the metadata
	const nostr = desc.find(tag => tag && tag.length >= 2 && tag[0] == "application/nostr")
	if (!nostr) {
		log(`Could not find application/nostr note in metadata for ${label}`)
		return
	}
	// Get the nostr tip request note from the bolt11 metadata
	let tipreq = nostr[1]

	// Make sure there are tags on the note
	if (!tipreq.tags || tipreq.tags.length === 0) {
		log(`No tags found in ${label}`)
		return
	}
	// Make sure we only have one p tag
	const ptags = tipreq.tags.filter(t => t && t.length && t.length >= 2 && t[0] === "p")
	if (ptags.length !== 1) {
		log(`None or multiple p tags found in ${label}`)
		return
	}
	// Make sure we have 0 or 1 etag (for note tipping)
	const etags = tipreq.tags.filter(t => t && t.length && t.length >= 2 && t[0] === "e")
	if (!(etags.length === 0 || etags.length === 1)) {
		log(`Expected none or 1 e tags in ${label}`)
		return
	}
	// Look for the relays tag, we will broadcast to these relays
	const relays_tag = tipreq.tags.find(t => t && t.length && t.length >= 2 && t[0] === "relays")
	if (!relays_tag) {
		log(`No relays tag found in ${label}`)
		return
	}

	const relays = relays_tag.slice(1)
	const ptag = ptags[0]
	const etag = etags.length > 0 && etags[0]
	const data = {ptag, tipreq, invoice, keypair, ptag, etag}
	const tip_note = await make_tip_note(data)
	//await send_note(relays, keypair, tip_note)

	log(JSON.stringify(tip_note))
}

async function make_tip_note({keypair, invoice, tipreq, ptag, etag}) {
	const kind = 9735
	const created_at = Math.floor(Date.now()/1000)
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

function log_error_file(e)
{
	fs.appendFile('log.txt', e.toString() + '\n', (err) => {
		if (err) throw err;
	});
}

plugin.onInit = plugin_init

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


async function clirpc(rpc, args) {
	const params = Object.keys(args).map(key => `${key}=${args[key]}`)
	const res = await dospawn("lightning-cli", rpc, params)
	return JSON.parse(res)
}

async function dotest() {
	const privkey = process.env.NOSTR_KEY
	if (!privkey) {
		console.log("set NOSTR_KEY")
		return
	}
	const res = await process_invoice_payment(privkey, {
		label: '12b15e85-f14d-46c8-9704-15f407c693b8'
	})
}

if (TESTING) {
	dotest()
} else {
	plugin.addOption('nostr-key', 'hexstr of a 32byte key', 'nostr secret key', 'string')
	plugin.start()
}
