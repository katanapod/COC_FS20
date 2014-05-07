// Class for connecting a CUL adapter to send and receive FS20 commands
// 2013 Thomas Schmidt
// MIT License
// https://github.com/netAction/CUL_FS20

// Connection to CUL adapter
var SerialPortModule = require("serialport");
var SerialPort = SerialPortModule.SerialPort;
var delimiter = "\r\n";

// logging to a file with timestamps and logrotate
var winston = require('winston');
winston.add(winston.transports.File, {
	filename: 'CUL_FS20.log',
	json: false,
	timestamp: function() {
		var now = new Date();
		var strDateTime = [
			[now.getDate(), (now.getMonth() + 1), now.getFullYear()].join("."),
			[
				now.getHours(),
				(now.getMinutes()<10?'0':'')+now.getMinutes(),
				(now.getSeconds()<10?'0':'')+now.getSeconds(),
				now.getMilliseconds(),
			].join(":")
			].join(" ");
		return strDateTime;
	}
});
// Disable console. If you need it run $ tail -f CUL_FS20.log
winston.remove(winston.transports.Console);

// Trigger events "connected" or "read"
var events = require('events');


// The class itself
function CUL_FS20() {
	this.serialPort = new SerialPort("/dev/ttyAMA0", {
		parser: SerialPortModule.parsers.readline(delimiter),
		baudrate: 38400		 
	});

	this.CUL_connected = false;

	this.commands = {
		// List of commands
		// http://fhz4linux.info/tiki-index.php?page=FS20%20Protocol
		// http://www.eecs.iu-bremen.de/archive/bsc-2008/stefanovIvan.pdf
		'off' : '00',
		'dim06' : '01', // Switch to Brightness level 1 (min.)
		'dim12' : '02',
		'dim18' : '03',
		'dim25' : '04',
		'dim31' : '05',
		'dim37' : '06',
		'dim43' : '07',
		'dim50' : '08',
		'dim56' : '09',
		'dim62' : '0A',
		'dim68' : '0B',
		'dim75' : '0C',
		'dim81' : '0D',
		'dim87' : '0E',
		'dim93' : '0F',
		'dim100' : '10', // Switch to Brightness level 16 (max.)
		'on' : '11', // dimmers: old value
		'toggle' : '12', // Switch between ”Off” and ”On at previous value”
		'dimup' : '13', // One level brighter.
		'dimdown' : '14', // One level darker.
		'dimupdown' : '15', // Dim up to max. level, pause, down ...
		'sendstate' : '17' // Send status. Only by bidirectional components.
	};

	// Objects for registered devices
	this.devices = {};
	events.EventEmitter.call(this);

	var self = this;
	winston.info('Starting CUL FS20 ...');
	self.serialPort.on("open", function () {
		// TODO: This does not log anything:
		winston.info('... connection to CUL opened ...');
		self.serialPort.on('data', function(data) {
			receiveData(data,self);
		});
		self.serialPort.write("X21\n", function(err, results) {
			if (err) {
				winston.error('error ' + err);
			} else {
				winston.info('... listening to FS20 commands.');
				self.CUL_connected = true;
				self.emit('connected');

				// some settings http://culfw.de/commandref.html
				// ask for Version number:
				// self.serialPort.write("V\n"); // answer: "V 1.46 CUL868"
				// ask for target amplitude:
				// self.serialPort.write("C1B\n"); // answer: "C1B = 07 /  7"
				// ask for decision boundery:
				// self.serialPort.write("C1D\n"); // answer: "C1D = 90 / 144" means 4dB
				// set to default of 8dB:
				// self.serialPort.write("W1F91\n"); // not tested
			}
		});
	});
}


function receiveData(data,self) {
	// data is the received signal. Buffer, no string!

	// winston.info("Raw data received: "+data.toString());
	// Reverse list of known commands
	var reverse_commands = {};
	for(var command in self.commands) {
		reverse_commands[self.commands[command]] = command;
	}

	// First character is "F" or "H".
	// F are the usual FS20 commands on, dim50, toggle...
	// H are Temperature, Humidity or stuff
	var prefix = data.toString().substr(0,1);

	// ### Strip out the command or any other useful data sent:
	// Everything after the address is the command.
	var command = data.toString().substr(prefix=="F" ? 7 : 5);
	// strip non alphanumeric
	command = command.replace(/\W/g, '');
	// strip checksum at the end
	command = command.substring(0,command.length-2);

	if ((prefix=="F") && (command in reverse_commands)) {
		command = reverse_commands[command];
	}
	// let the user decide what to do with the data with H prefix.

	// ### Strip out the device's address:
	// Reverse list of FS20 devices
	var reverse_devices = {};
	for(var device in self.devices) {
		reverse_devices[self.devices[device].address] = device;
	}

	// convert FS20 address to device name
	// if device not registered keep FS20 address
	// Second to seventh character is the device's address.
	var device = data.toString().substr(1,prefix=="F" ? 6 : 4);
	if (device in reverse_devices) {
		device = reverse_devices[device];
		self.devices[device].lastCommand = command;
	}

	var message = {
		'prefix' : prefix,
		'device' : device,
		'command' : command,
		'full' : device+' '+command
	}
	winston.info('Received: '+prefix+' '+message.full);
	self.emit('read',message);
} // receiveData


CUL_FS20.prototype.write = function(message) {
	if (this.CUL_connected == false) {
		winston.error("CUL not connected.");
		return;
	}
	if (!(message.command in this.commands)) {
		winston.error("Command "+message.command+" unknown.");
		return;
	}

	/* http://culfw.de/commandref.html
		F12340111
		F = FS20 writing command
		 1234 = FS20 housecode (hex)
				 01 = device address (hex)
					 11 = command (16bit if extension bit is set in first byte) */

	command = this.commands[message.command];
	this.serialPort.write("F"+message.address+command+"\n");
} // CUL_FS20.write


function FS20_Device(CUL_FS20_Obj,deviceName,address) {
	for(var command in CUL_FS20_Obj.commands) {
		(function(obj,addr,cmd,self) {
			self[command] = function() {
				obj.write({'address':addr,'command':cmd});
				winston.info('   Sent: '+this.name+' '+cmd);
				self.lastCommand = cmd;
			}
		})(CUL_FS20_Obj,address,command,this);
	}
	this.address = address;
	this.name = deviceName;
	// at startup we do not know the last command on this address:
	this.lastCommand = false;
	this.toString = function() {
		return this.lastCommand;
	}
}

CUL_FS20.prototype.registerDevices = function(deviceNames) {
	for(var deviceName in deviceNames) {
		this.devices[deviceName] = new FS20_Device(this,deviceName,deviceNames[deviceName]);
	}
	return this.devices;
} // CUL_FS20.registerDevices


CUL_FS20.prototype.__proto__ = events.EventEmitter.prototype;

module.exports = CUL_FS20;

