"use strict";

let path = require('path');
let fs = require('fs');

module.exports = class Server{
	/*#modules = [];dals = [];*///waiting for private
	constructor (type) {
		this.paths = {
			modules: [],
			dals: []
		};

		switch(type){
			case 'watcher': 
				this.server = 'watcher';
			break;
			default:
				this.server = 'server';
		}
	}
	addModulesPath (...args) {
		this.paths.modules = this.paths.modules.concat(args);
	}
	addDalPath (...args) {
		this.paths.dals = this.paths.dals.concat(args);
	}
	init (config={}){
		let startPath = path.dirname(new Error().stack.split('\n').splice(2, 1)[0].match(/at[^\(]*\(([^\)]+)\)/)[1]);
		if(!config.logPath){
			config.logPath = startPath;
		}
		if(config.modules && !Array.isArray(config.modules)){
			throw 'config.modules must be Array';
		}
		if(config.dals && !Array.isArray(config.dals)){
			throw 'config.dals must be Array';
		}
		if(config.modules){
			this.paths.modules = this.paths.modules.concat(config.modules);
			delete config.modules;
		}
		if(config.dals){
			this.paths.dals = this.paths.dals.concat(config.dals);
			delete config.dals;
		}
		if(!this.paths.modules.length){
			this.paths.modules.push(path.join(startPath, 'modules'));
		}
		this.paths.modules = this.paths.modules.reduce((res, path) => {
			if(!path.isAbsolute(path)){
				path = path.join(startPath, path);
			}
			if(fs.statSync(path).isDirectory()){
				res.push(path);
			}
			else{
				console.log('modules path ', path, 'not created or is not directory');
			}
			return res;
		}, []);
		if(!this.paths.modules.length){
			throw 'you must specify the path to the modules in config.modules, type - Array of strings';
		}
		this.paths.dals = this.paths.dals.reduce((res, path) => {
			if(!path.isAbsolute(path)){
				path = path.join(startPath, path);
			}
			if(fs.statSync(path).isDirectory()){
				res.push(path);
			}
			else{
				console.log('dals path ', path, 'not created or is not directory');
			}
			return res;
		}, []);
		if(!config.useDals || !config.useDals.length){
			if(!config.skipDbWarning){
				console.log('config.useDals not defined, no one database will be included');
			}
		}
		if(config.type){
			switch(config.type){
				case 'watcher': 
					this.server = 'watcher';
				break;
				default:
					this.server = 'server';
			}
		}
		this.paths.startPath = startPath;
		let server = require(path.join(__dirname, 'system/' + this.server));
		server.start(this.paths, config);
	}
}
