# Installing GivEnergy for Homey (Alpha Testing)

Thanks for helping test the GivEnergy app! Follow these steps to install it on your Homey Pro.

## Prerequisites

- A Homey Pro (2023 or later) on the same network as your computer
- A computer running macOS, Windows, or Linux
- Node.js installed on your computer

### Installing Node.js

1. Go to https://nodejs.org
2. Download the **LTS** version (the one on the left)
3. Run the installer and follow the prompts — the default options are fine

## Step 1: Download the app

1. Go to https://github.com/jak/io.jak.givenergy
2. Click the green **Code** button
3. Click **Download ZIP**
4. Unzip the downloaded file — you should end up with a folder called `io.jak.givenergy-main`

## Step 2: Open a terminal

### macOS

Open **Terminal** (search for "Terminal" in Spotlight, or find it in Applications → Utilities).

### Windows

Open **Command Prompt** (search for "cmd" in the Start menu).

## Step 3: Navigate to the app folder

Type `cd ` (with a space after it), then drag the unzipped folder onto the terminal window. This fills in the path for you. Press **Enter**.

It should look something like:

```
cd /Users/yourname/Downloads/io.jak.givenergy-main
```

## Step 4: Install dependencies

Run the following command and wait for it to finish:

```
npm install
```

## Step 5: Install the app on your Homey

Run:

```
npx homey app install
```

The first time you run this, it will ask you to log in to your Athom account in your browser. Follow the prompts to authorize the CLI.

Once authorized, the app will be installed on your Homey. You should see it appear in the Homey app.

## Step 6: Add your inverter

1. Open the **Homey** app on your phone
2. Tap **Devices** → **+** → **GivEnergy**
3. Choose **Solar Inverter** and enter your inverter's IP address
4. After adding the inverter, you can also add the **Battery** and **Grid Meter** devices

## Updating to a newer version

When a new version is available:

1. Download the ZIP again from GitHub (or pull the latest changes if you used git)
2. Open a terminal and navigate to the folder
3. Run `npm install` again
4. Run `npx homey app install` again

## Troubleshooting

- **"command not found: npx"** — Node.js is not installed or not in your PATH. Reinstall Node.js and restart your terminal.
- **"Could not find a Homey on the network"** — Make sure your computer is on the same Wi-Fi network as your Homey Pro.
- **Login issues** — Try running `npx homey logout` then `npx homey app install` again.

## Questions?

Post in the [Homey Community topic](https://community.homey.app/t/app-pro-givenergy/152231) or open an [issue on GitHub](https://github.com/jak/io.jak.givenergy/issues).
