import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import {
  Client,
  Collection,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { openDb } from './db.js';

dotenv.config();
const app = express();
app.use(express.json());
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
});
const discordRest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

var db;

async function authenticate(req, res, next) {
  if (!client.isReady()) {
    res.status(500).send('Discord client is not ready');
    return;
  }

  if (!req.headers.authorization) {
    res.status(401).send('Missing authorization header');
    return;
  }

  let authHeader = req.headers.authorization;
  if (authHeader.startsWith('Bearer ')) authHeader = authHeader.slice(7);

  authHeader = Buffer.from(authHeader, 'base64').toString('utf-8');

  const split = authHeader.split(':');
  let user = split[0];
  let pass = split[1];

  if (!user || !pass) {
    res.status(401).send('Invalid authorization header');
    return;
  }

  const userRow = await db.get('SELECT * FROM users WHERE user_id = ?', user);
  if (!userRow) {
    res.status(401).send('Invalid user');
    return;
  }

  const hash = crypto
    .createHash('sha256')
    .update(process.env.SECRET + pass)
    .digest('hex');

  if (hash !== userRow.token) {
    res.status(401).send('Invalid token');
    return;
  }

  req.user = userRow;
  next();
}

app.use(authenticate);

app.post('/', async (req, res) => {
  const commands = JSON.parse(fs.readFileSync('./commands.json', 'utf8'));
  const command = commands.find((c) => c.name === req.body.command);
  if (!command) {
    res.status(404).send('Command not found');
    return;
  }

  const user = req.user;
  const steam = await fetchSteamUser(user.steam_id);
  const steamName = steam.personaname;

  const args = req.body.args ?? {};
  args.steamName = steamName;

  const regex = /%(\w+)%/g;
  const cmd = command.command.replace(regex, (match, key) => args[key]);

  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const channel = await guild.channels.fetch(process.env.CHANNEL_ID);

  if (!channel || channel.type !== ChannelType.GuildText) {
    res.status(500).send('Channel not found');
    return;
  }

  const message = await channel.send(cmd);
  res.status(200).send('Command executed');
  await db.run('INSERT INTO api_usage (user_id, action) VALUES (?, ?)', [
    user.id,
    `Execute command: ${cmd}`,
  ]);
});

client.on('ready', async () => {
  console.log('Ready!');
  const cmdBldr = new SlashCommandBuilder().setName('rust').setDescription('Rust commands');
  cmdBldr.addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Grant api key')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('User to grant key to').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('steam').setDescription('Users steam name').setRequired(true)
      )
  );
  cmdBldr.addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Revoke api key')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('User to revoke key from').setRequired(true)
      )
  );
  cmdBldr.addSubcommand((sub) => sub.setName('list').setDescription('List api holders and usage'));
  cmdBldr.addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Get info about a user')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('User to get info about').setRequired(true)
      )
  );
  cmdBldr.addSubcommand((sub) =>
    sub
      .setName('usage')
      .setDescription('List api usage for a user')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('User to list usage for').setRequired(true)
      )
  );
  cmdBldr.addSubcommand((sub) =>
    sub
      .setName('removeid')
      .setDescription('Remove a user by id')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Id of user to remove').setRequired(true)
      )
  );
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  if (!guild) {
    console.error('Guild not found');
    process.exit(1);
  }

  const data = await discordRest.put(Routes.applicationGuildCommands(client.user.id, guild.id), {
    body: [cmdBldr.toJSON()],
  });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;
  const { commandName, options } = interaction;
  if (commandName !== 'rust') return;

  if (!interaction.member.roles.cache.has(process.env.ROLE_ID)) {
    interaction.reply({
      content: 'You do not have permission to use this command',
      ephemeral: true,
    });
    return;
  }

  const subCommand = options.getSubcommand();
  switch (subCommand) {
    case 'add': {
      const user = options.getUser('user');
      const steam = options.getString('steam');
      handleAdd(interaction, user, steam);
      return;
    }
    case 'remove': {
      const user = options.getUser('user');
      handleRemove(interaction, user);
      return;
    }
    case 'removeid': {
      const id = options.getString('id');
      handleRemoveId(interaction, { id });
    }
    case 'info': {
      const user = options.getUser('user');
      handleInfo(interaction, user);
      return;
    }
    case 'list': {
      handleList(interaction);
      return;
    }
    case 'usage': {
      const user = options.getUser('user');
      handleUsage(interaction, user);
      return;
    }
  }
});

async function handleAdd(interaction, user, steam) {
  const steamId = await getIDFromSteamUser(steam);
  if (!steamId.success || !steamId.steamid) {
    interaction.reply({ content: 'Invalid steam user', ephemeral: true });
    return;
  }

  const alreadyExists = await db.get('SELECT * FROM users WHERE user_id = ?', [user.id]);
  if (alreadyExists) {
    interaction.reply({ content: 'User already exists', ephemeral: true });
    return;
  }

  const token = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .createHash('sha256')
    .update(process.env.SECRET + token)
    .digest('hex');
  await db.run('INSERT INTO users (user_id, steam_id, token) VALUES (?, ?, ?)', [
    user.id,
    steamId.steamid,
    hash,
  ]);
  await db.run('INSERT INTO api_usage (user_id, action) VALUES (?, ?)', [user.id, 'Generate key']);

  interaction.reply({
    content: `User added. Token: ${token}`,
    ephemeral: true,
  });
}

async function handleRemove(interaction, user) {
  const userRow = await db.get('SELECT * FROM users WHERE user_id = ?', [user.id]);
  if (!userRow) {
    interaction.reply({ content: 'User does not exist', ephemeral: true });
    return;
  }

  await db.run('DELETE FROM users WHERE user_id = ?', [user.id]);
  await db.run('DELETE FROM api_usage WHERE user_id = ?', [user.id]);

  interaction.reply({ content: 'User removed', ephemeral: true });
}

async function handleInfo(interaction, user) {
  const userRow = await db.get('SELECT * FROM users WHERE user_id = ?', [user.id]);
  if (!userRow) {
    interaction.reply({ content: 'User does not exist', ephemeral: true });
    return;
  }

  const steamUser = await fetchSteamUser(userRow.steam_id);
  const usage = await db.all('SELECT * FROM api_usage WHERE user_id = ?', [user.id]);

  const embed = new EmbedBuilder()
    .setTitle(user.username)
    .setDescription(
      `Steam: ${steamUser.personaname} (\`${userRow.steam_id}\`)\nUsage: ${
        usage.length
      }\nLast used: ${usage[usage.length - 1].date}`
    );

  interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleList(interaction) {
  const users = await db.all('SELECT * FROM users');
  const embed = new EmbedBuilder();
  embed.setTitle('API users');
  const fields = [];
  for (const user of users) {
    const usage = await db.get('SELECT COUNT(*) as count FROM api_usage WHERE user_id = ?', [
      user.user_id,
    ]);
    fields.push(`<@${user.user_id}> - ${usage.count}`);
  }
  embed.setDescription(fields.join('\n'));
  interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleUsage(interaction, user) {
  const usage = await db.all('SELECT * FROM api_usage WHERE user_id = ?', [user.id]);
  const embed = new EmbedBuilder();
  embed.setTitle(`Usage for ${user.username}`);
  const fields = [];
  for (const use of usage) {
    fields.push(`${use.date} - ${use.action}`);
  }
  embed.setDescription(fields.join('\n'));
  interaction.reply({ embeds: [embed], ephemeral: true });
}

async function fetchSteamUser(id) {
  const resp = await fetch(
    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${process.env.STEAM_TOKEN}&steamids=${id}&format=json`
  );
  const json = await resp.json();
  return json.response.players[0];
}

async function getIDFromSteamUser(user) {
  const resp = await fetch(
    `http://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${process.env.STEAM_TOKEN}&vanityurl=${user}&format=json`
  );
  const json = await resp.json();
  return json.response;
}

app.listen(process.env.PORT, async () => {
  console.log(`Listening on port ${process.env.PORT}`);
  db = await openDb();
  await db.exec(
    'CREATE TABLE IF NOT EXISTS users (user_id varchar(36), steam_id varchar(36), token varchar(36), PRIMARY KEY (user_id));'
  );
  await db.exec(
    'CREATE TABLE IF NOT EXISTS api_usage (user_id varchar(36), action varchar(255), date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, date));'
  );

  client.login(process.env.DISCORD_TOKEN);
});
