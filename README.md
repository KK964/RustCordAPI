# RustCordAPI

A simple API for external Rustcord usage.

## Getting Started

Install the dependencies:

- [Node.js](https://nodejs.org/en/) (v16.9.0 or higher)

```bash
npm install
```

Setup sqlite database: (top level RustCordAPI folder)

```bash
sqlite3 user.db
```

Running the server:

```bash
npm run start
```

## API

POST /

- Headers:
  - Authorization: Bearer <token>
    - Token is base64 encoded of: `userId:token`
- Body:

```json
{
  "command": "command",
  "args": {
    "arg1": "value1",
    "arg2": "value2"
  }
}
```
