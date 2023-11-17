import { Hono } from 'hono'
import { html } from 'hono/html'

import {
    nip19,
    getPublicKey,
    getEventHash,
    signEvent,
    Event,
    SimplePool,
} from 'nostr-tools'

const pool = new SimplePool()
const relays = ['wss://yabu.me', 'wss://relay-jp.nostr.wirednet.jp', 'wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.nostr.band']

type Bindings = {
    DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

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
            <title>画像bot</title>
        </head>
        <body>
            {props.results.map((result) => {
                return <div><h3><a href={"/" + result?.name}>{result?.name}</a></h3></div>
            })}
        </body>
    </html>
);

const Entry = (props: { results: Record[], name: string }) => (
    <html>
        <head>
            <title>{props.name}画像</title>
        </head>
        <body>
            <h1>{props.name}画像</h1>
            {props.results.map((result) => {
                const url = new URL(result?.image);
                if (url.pathname.endsWith('.mp4') || url.pathname.endsWith('.mov')) {
                    return <div><h3><a href={"https://nostter.app/" + result?.note}>{result?.note}</a></h3><video controls style="width: 500px"><source src={result?.image} /></video></div>
                }
                return <div><h3><a href={"https://nostter.app/" + result?.note}>{result?.note}</a></h3><img style="width: 500px" src={result?.image} /></div>
            })}
        </body>
    </html >
);

app.get(`/`, async (c) => {
    try {
        const results = await c.env.DB.prepare("SELECT DISTINCT name FROM images ORDER BY NAME").all<Record>()
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
        const results = await c.env.DB.prepare("SELECT * FROM images WHERE name = ? ORDER BY ID").bind(name).all<Record>()
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
    try {
        const event = await c.req.json<Event>()
        const tok = event.content.split(/\s+/)
        console.log(tok)
        if (tok[0].startsWith('nostr:')) tok.shift()
        if (tok[0].startsWith('@')) tok.shift()
        if (tok.length < 3) throw "bad command"
        if (tok[1] === 'add') {
            const name = tok[0].replace(/画像$/, '')
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
                        throw "bad type: " + type
                }
                const note = await pool.get(getrelays, {
                    ids: [id],
                })
                for (const image of note.content.match(/https?:\/\/[^\s]+/g)) {
                    await c.env.DB.prepare("INSERT INTO images(name, note, image, created_at) values(?, ?, ?, ?)").bind(name, nip19.noteEncode(note.id), image, note.created_at).run()
                }
            }
            return c.json(createReplyWithTags(c.env, event, 'OK', []))
        }
        if (tok[1] === 'delete') {
            const name = tok[0].replace(/画像$/, '')
            for (const note of tok.slice(2)) {
                await c.env.DB.prepare("DELETE FROM images WHERE name = ? AND note = ?").bind(name, note).run()
                return c.json(createReplyWithTags(c.env, event, 'OK', []))
            }
        }
        return c.json(createReplyWithTags(c.env, event, 'わかりません', []))
    } catch (e) {
        return c.json({ err: e }, 404)
    }
});

export default app
