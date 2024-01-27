import { Hono } from 'hono'
import { html } from 'hono/html'
import { serveStatic } from 'hono/cloudflare-workers'

import {
    nip19,
    getPublicKey,
    getEventHash,
    signEvent,
    Event,
    SimplePool,
} from 'nostr-tools'

const pool = new SimplePool({ eoseSubTimeout: 30 * 1000, getTimeout: 30 * 1000 })
const relays = ['wss://yabu.me', 'wss://relay-jp.nostr.wirednet.jp', 'wss://nos.lol', 'wss://relay.damus.io']

type Bindings = {
    DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('/public/*', serveStatic({ root: './' }))

function createReplyWithTags(env: Env, mention: Event, message: string, tags: string[][]): Event {
    const decoded = nip19.decode(env.NULLPOGA_NSEC)
    const sk = decoded.data as string
    const pk = getPublicKey(sk)
    if (mention.pubkey == pk) throw new Error('Self reply not acceptable')
    const tt = []
    tt.push(['e', mention.id], ['p', mention.pubkey])
    if (mention.kind == 42) {
        for (let tag of mention.tags.filter((x: any[]) => x[0] === 'e')) {
            tt.push(tag)
        }
    }
    for (let tag of tags) {
        tt.push(tag)
    }
    const created_at = mention.created_at + 1
    let event = {
        id: '',
        kind: mention.kind,
        pubkey: pk,
        created_at: created_at, // Math.floor(Date.now() / 1000),
        tags: tt,
        content: message,
        sig: '',
    }
    event.id = getEventHash(event)
    event.sig = signEvent(event, sk)
    return event
}

interface Record {
    id: number;
    name: string;
    note: string;
    image: string;
    created_at: string;
}

const Top = (props: { results: Record[] }) => (
    <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>画像bot</title>
            <link rel="stylesheet" type="text/css" href="/public/style.css" media="all" />
        </head>
        <body>
            <h1>Nostr 画像 bot</h1>
            {props.results.map((result) => {
                return <div class="name">📔 <a href={"/" + result?.name}>{result?.name}</a></div>
            })}
        </body>
    </html>
);

const Entry = (props: { results: Record[], name: string }) => (
    <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>{props.name}画像</title>
            <link rel="stylesheet" type="text/css" href="/public/style.css" media="all" />
        </head>
        <body>
            <h1><a href="/" class="anchor">👈</a> {props.name}画像</h1>
            {props.results.map((result) => {
                const url = new URL(result?.image);
                if (url.pathname.endsWith('.mp4') || url.pathname.endsWith('.mov')) {
                    return <div>
                        <h4>✍️ <a href={"https://nostter.app/" + result?.note}>{result?.note}</a></h4>
                        <div class="image-container"><video controls style="width: 500px"><source src={result?.image} /></video></div>
                    </div>
                }
                return <div>
                    <h4>✍️ <a href={"https://nostter.app/" + result?.note}>{result?.note}</a></h4>
                    <div class="image-container"><img style="width: 500px" src={result?.image} loading="lazy" /></div>
                </div>
            })}
        </body>
    </html>
);

app.get(`/export.json`, async (c) => {
    try {
        const results = await c.env.DB.prepare("SELECT * FROM images ORDER BY created_at").all<Record>()
        return c.json(results.results, 200)
    } catch (e) {
        return c.json({ err: e }, 404)
    }
})

app.get(`/`, async (c) => {
    try {
        const results = await c.env.DB.prepare("SELECT DISTINCT name FROM images ORDER BY name").all<Record>()
        const props = {
            results: results.results,
        }
        return c.html(<Top {...props} />)
    } catch (e) {
        return c.json({ err: e }, 404)
    }
})

app.get(`/:name`, async (c) => {
    try {
        const name = c.req.param('name').replace(/画像$/, '').trim()
        const results = await c.env.DB.prepare("SELECT * FROM images WHERE name = ? ORDER BY id").bind(name).all<Record>()
        const props = {
            results: results.results,
            name: name,
        }
        return c.html(<Entry {...props} />)
    } catch (e) {
        return c.json({ err: e }, 404)
    }
});

app.post(`/select`, async (c) => {
    try {
        const event = await c.req.json<Event>()
        const name = event.content.replace(/画像$/, '').trim()
        const result = await c.env.DB.prepare("SELECT * FROM images WHERE name = ? ORDER BY RANDOM() LIMIT 1").bind(name).first<Record>()
        if (result === null) throw "not found";
        return c.json(createReplyWithTags(c.env, event, `#${result?.name + '画像'}\n${result?.image || ''}`, [['t', result?.name + '画像']]))
    } catch (e) {
        return c.json({ err: e }, 404)
    }
});

app.post(`/command`, async (c) => {
    const event = await c.req.json<Event>()
    try {
        const tok = event.content.split(/\s+/)
        console.log(tok)
        if (tok[0].startsWith('nostr:')) tok.shift()
        if (tok[0].startsWith('@')) tok.shift()
        if (tok[1] === 'list') {
            const name = tok[0].replace(/画像$/, '')
            return c.json(createReplyWithTags(c.env, event, 'https://image-bot.mattn-jp.workers.dev/' + encodeURI(name), []))
        } else if (tok[1] === 'add') {
            const name = tok[0].replace(/画像$/, '')
            if (tok.length == 2) {
                for (let t of event.tags.filter((x: any[]) => x[0] === 'e').map((e: any[]) => nip19.noteEncode(e[1]))) {
                    tok.push(t)
                }
            }
            for (const item of tok.slice(2)) {
                const { type, data } = nip19.decode(item.replace(/^(nostr:)/, ''))
                let id = data
                let getrelays = [...relays]
                console.log(type, data)
                switch (type) {
                    case 'note':
                        id = data
                        break;
                    case 'nevent':
                        id = data.id
                        getrelays = getrelays.concat(data.relays)
                        break;
                    default:
                        throw "変な種別: " + type
                }
                console.log(id)
                console.log(relays)
                const note = await pool.get(getrelays, {
                    ids: [id],
                })
                console.log(note)
                for (const image of note.content.match(/https?:\/\/[^\s]+/g)) {
                    const results = await c.env.DB.prepare("SELECT * FROM images WHERE note = ?").bind(nip19.noteEncode(note.id)).all<Record>()
                    if (results.results.length == 0) {
                        await c.env.DB.prepare("INSERT INTO images(name, note, image, created_at) values(?, ?, ?, ?)").bind(name, nip19.noteEncode(note.id), image, note.created_at).run()
                    }
                }
                console.log("done")
            }
            return c.json(createReplyWithTags(c.env, event, 'OK', []))
        } else if (tok[1] === 'delete') {
            if (tok.length < 3) throw "変なコマンド"
            const name = tok[0].replace(/画像$/, '')
            for (const note of tok.slice(2)) {
                await c.env.DB.prepare("DELETE FROM images WHERE name = ? AND note = ?").bind(name, note).run()
                return c.json(createReplyWithTags(c.env, event, 'OK', []))
            }
            return c.json(createReplyWithTags(c.env, event, 'OK', []))
        }
        throw "変なコマンド"
    } catch (e) {
        return c.json(createReplyWithTags(c.env, event, 'エラーが発生しました: ' + e, []))
    }
});

export default app
